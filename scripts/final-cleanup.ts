/**
 * Final cleanup pass: fill every remaining gap we can.
 */
import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.join(process.cwd(), '.env.local'), override: true });
dotenv.config({ path: path.join(process.cwd(), '.env') });

import { createClient } from '@supabase/supabase-js';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SECRET_KEY || '',
  { auth: { autoRefreshToken: false, persistSession: false } }
);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

function initFirebase() {
  if (getApps().length) return;
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_JSON_BASE64 || '';
  const json = JSON.parse(Buffer.from(b64, 'base64').toString('utf-8'));
  initializeApp({ credential: cert(json) });
}

async function callOpenAI(prompt: string, maxTokens = 4096): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
        max_tokens: maxTokens,
      }),
      signal: controller.signal,
    });
    const json = await resp.json();
    return json.choices?.[0]?.message?.content || '';
  } finally {
    clearTimeout(timeout);
  }
}

// ── 1. Fetch file_url from Firestore for docs that have firestore_id but no file_url ──
async function fix1_fetchFileUrlFromFirestore() {
  console.log('\n── Fix 1: Fetch file_url from Firestore for 2094 docs ──');
  initFirebase();
  const db = getFirestore();

  // Get client UID mapping
  const clientUids = new Map<string, string>();
  let cOff = 0;
  while (true) {
    const { data } = await supabase.from('clients').select('id, firebase_uid').not('firebase_uid', 'is', null).range(cOff, cOff + 999);
    if (!data?.length) break;
    for (const c of data) clientUids.set(c.id, c.firebase_uid);
    if (data.length < 1000) break;
    cOff += 1000;
  }

  // Load docs with firestore_id but no file_url
  const docsToFix: any[] = [];
  let offset = 0;
  while (true) {
    const { data } = await supabase
      .from('client_documents')
      .select('id, client_id, firestore_id')
      .not('firestore_id', 'is', null)
      .is('file_url', null)
      .range(offset, offset + 999);
    if (!data?.length) break;
    docsToFix.push(...data);
    if (data.length < 1000) break;
    offset += 1000;
  }
  console.log(`  Found ${docsToFix.length} docs to fetch`);

  // Group by client
  const byClient = new Map<string, any[]>();
  for (const d of docsToFix) {
    const list = byClient.get(d.client_id) || [];
    list.push(d);
    byClient.set(d.client_id, list);
  }

  let updated = 0;
  let clientNum = 0;
  for (const [clientId, docs] of byClient) {
    clientNum++;
    const uid = clientUids.get(clientId);
    if (!uid) continue;

    try {
      // Fetch all Firestore docs for this client at once
      const fsSnap = await db.collection('Clients').doc(uid).collection('Client Documents').get();
      const fsMap = new Map<string, any>();
      fsSnap.forEach(doc => fsMap.set(doc.id, doc.data()));

      for (const doc of docs) {
        const fsData = fsMap.get(doc.firestore_id);
        if (!fsData) continue;

        const uploadedFiles: string[] = fsData['Uploaded Files'] || fsData['uploadedFiles'] || [];
        const fileUrl = uploadedFiles[0];
        if (!fileUrl) continue;

        const fileName = decodeURIComponent(fileUrl.split('/').pop()?.split('?')[0] || '');
        let contentType = 'image/jpeg';
        const lUrl = fileUrl.toLowerCase();
        if (lUrl.includes('.pdf')) contentType = 'application/pdf';
        else if (lUrl.includes('.png')) contentType = 'image/png';
        else if (lUrl.includes('.heic')) contentType = 'image/heic';
        else if (lUrl.includes('.webp')) contentType = 'image/webp';

        const filePath = fileUrl.includes('/o/') ? decodeURIComponent((fileUrl.match(/\/o\/([^?]+)/)?.[1]) || '') : '';

        const uploadDate = fsData['Upload date'] || fsData['uploadDate'];
        let uploadedAt: string | null = null;
        if (uploadDate) {
          if (uploadDate.toDate) uploadedAt = uploadDate.toDate().toISOString();
          else if (uploadDate._seconds) uploadedAt = new Date(uploadDate._seconds * 1000).toISOString();
        }

        const updateObj: Record<string, any> = { file_url: fileUrl, file_name: fileName, content_type: contentType };
        if (filePath) updateObj.file_path = filePath;
        if (uploadedAt) updateObj.uploaded_at = uploadedAt;

        await supabase.from('client_documents').update(updateObj).eq('id', doc.id);
        updated++;
      }
    } catch (err) { /* skip */ }

    if (clientNum % 100 === 0) console.log(`  Progress: ${clientNum}/${byClient.size} clients, updated ${updated}`);
  }
  console.log(`  ✅ Updated: ${updated}`);
}

// ── 2. OpenAI: match remaining 105 for_who → family_member_id ──
async function fix2_aiRemainingFamilyMembers() {
  console.log('\n── Fix 2: AI match remaining for_who → family_member_id ──');

  const allMembers: any[] = [];
  let memOffset = 0;
  while (true) {
    const { data } = await supabase.from('family_members').select('id, client_id, first_name, last_name').range(memOffset, memOffset + 999);
    if (!data?.length) break;
    allMembers.push(...data);
    if (data.length < 1000) break;
    memOffset += 1000;
  }
  const membersByClient = new Map<string, any[]>();
  for (const m of allMembers) {
    const list = membersByClient.get(m.client_id) || [];
    list.push(m);
    membersByClient.set(m.client_id, list);
  }

  const unmatchedByClient = new Map<string, any[]>();
  let offset = 0;
  while (true) {
    const { data: docs } = await supabase
      .from('client_documents')
      .select('id, client_id, for_who')
      .is('family_member_id', null)
      .not('for_who', 'is', null)
      .neq('for_who', '')
      .range(offset, offset + 999);
    if (!docs?.length) break;
    for (const d of docs) {
      const list = unmatchedByClient.get(d.client_id) || [];
      list.push(d);
      unmatchedByClient.set(d.client_id, list);
    }
    if (docs.length < 1000) break;
    offset += 1000;
  }

  const totalDocs = [...unmatchedByClient.values()].reduce((s, l) => s + l.length, 0);
  console.log(`  ${totalDocs} docs across ${unmatchedByClient.size} clients`);

  let totalUpdated = 0;

  for (const [clientId, docs] of unmatchedByClient) {
    const members = membersByClient.get(clientId) || [];
    if (!members.length) continue;

    const uniqueForWho = [...new Set(docs.map(d => d.for_who.trim()))];
    const memberEntries = members.map((m, i) => ({ idx: i + 1, id: m.id, label: `${m.first_name || ''} ${m.last_name || ''}`.trim() }));

    // More aggressive prompt: try harder
    const prompt = `Match names to family members. Be aggressive with partial matching.
Members:
${memberEntries.map(e => `${e.idx}. ${e.label}`).join('\n')}

Documents:
${uniqueForWho.map((w, j) => `${j + 1}. "${w}"`).join('\n')}

Rules:
- Multiple names? Match FIRST name
- "Sandrine Cecile" → match "Sandrine" or "Cecile" to closest member
- Case/accent insensitive
- Even if only a partial first name matches → match it
- Only null if truly no resemblance

Reply ONLY valid JSON: [{"fw": 1, "m": 2}]`;

    try {
      const content = await callOpenAI(prompt, 1024);
      const cleaned = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const matches: { fw: number; m: number | null }[] = JSON.parse(cleaned);

      for (const match of matches) {
        const forWhoValue = uniqueForWho[match.fw - 1];
        if (!forWhoValue || !match.m || !memberEntries[match.m - 1]) continue;

        const memberId = memberEntries[match.m - 1].id;
        const matchingDocs = docs.filter(d => d.for_who.trim() === forWhoValue);
        await Promise.all(matchingDocs.map(d =>
          supabase.from('client_documents').update({ family_member_id: memberId }).eq('id', d.id)
        ));
        totalUpdated += matchingDocs.length;
      }
    } catch (err) { /* skip */ }
  }
  console.log(`  ✅ Updated: ${totalUpdated}`);
}

// ── 3. OpenAI: classify remaining 63 document_type_id ──
async function fix3_aiRemainingDocTypes() {
  console.log('\n── Fix 3: AI classify remaining document_type_id ──');

  const { data: docTypes } = await supabase.from('document_types').select('id, label_fr, label_he, label_en');
  if (!docTypes?.length) { console.log('  No document_types table!'); return; }

  const { data: unmatched } = await supabase
    .from('client_documents')
    .select('id, document_type')
    .is('document_type_id', null)
    .limit(200);

  if (!unmatched?.length) { console.log('  All matched!'); return; }
  console.log(`  ${unmatched.length} docs to classify`);

  const uniqueTypes = [...new Set(unmatched.map(d => d.document_type))];
  const refList = docTypes.map(t => `${t.id}: ${t.label_fr}${t.label_en ? ' / ' + t.label_en : ''}`).join('\n');

  const prompt = `Classify these document types to the closest reference type.

Reference types:
${refList}

Document types to classify:
${uniqueTypes.map((t, i) => `${i + 1}. "${t}"`).join('\n')}

Rules: Match by meaning, not exact text. All must be matched to something.
Reply ONLY valid JSON: [{"idx": 1, "type_id": "uuid-here"}]`;

  try {
    const content = await callOpenAI(prompt, 4096);
    const cleaned = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const matches: { idx: number; type_id: string }[] = JSON.parse(cleaned);

    let updated = 0;
    for (const match of matches) {
      const docType = uniqueTypes[match.idx - 1];
      if (!docType || !match.type_id) continue;

      const docsToUpdate = unmatched.filter(d => d.document_type === docType);
      await Promise.all(docsToUpdate.map(d =>
        supabase.from('client_documents').update({ document_type_id: match.type_id }).eq('id', d.id)
      ));
      updated += docsToUpdate.length;
    }
    console.log(`  ✅ Updated: ${updated}`);
  } catch (err: any) {
    console.error('  Error:', err.message);
  }
}

// ── 4. Fill remaining uploaded_at from created_at ──
async function fix4_fillUploadedAt() {
  console.log('\n── Fix 4: Fill uploaded_at from created_at ──');
  let offset = 0;
  let updated = 0;
  while (true) {
    const { data: docs } = await supabase
      .from('client_documents')
      .select('id, created_at')
      .is('uploaded_at', null)
      .range(offset, offset + 999);
    if (!docs?.length) break;
    await Promise.all(docs.map(d =>
      supabase.from('client_documents').update({ uploaded_at: d.created_at }).eq('id', d.id)
    ));
    updated += docs.length;
    if (docs.length < 1000) break;
    offset += 1000;
  }
  console.log(`  ✅ Updated: ${updated}`);
}

// ── 5. Fill content_type for docs that have file_url but no content_type ──
async function fix5_fillContentType() {
  console.log('\n── Fix 5: Fill remaining content_type ──');
  let offset = 0;
  let updated = 0;
  while (true) {
    const { data: docs } = await supabase
      .from('client_documents')
      .select('id, file_url')
      .not('file_url', 'is', null)
      .is('content_type', null)
      .range(offset, offset + 999);
    if (!docs?.length) break;
    await Promise.all(docs.map(d => {
      const l = d.file_url.toLowerCase();
      let ct = 'image/jpeg';
      if (l.includes('.pdf')) ct = 'application/pdf';
      else if (l.includes('.png')) ct = 'image/png';
      else if (l.includes('.gif')) ct = 'image/gif';
      else if (l.includes('.webp')) ct = 'image/webp';
      else if (l.includes('.heic')) ct = 'image/heic';
      const fp = l.includes('/o/') ? decodeURIComponent((d.file_url.match(/\/o\/([^?]+)/)?.[1]) || '') : '';
      const upd: Record<string, any> = { content_type: ct };
      if (fp) upd.file_path = fp;
      return supabase.from('client_documents').update(upd).eq('id', d.id);
    }));
    updated += docs.length;
    if (docs.length < 1000) break;
    offset += 1000;
  }
  console.log(`  ✅ Updated: ${updated}`);
}

async function main() {
  console.log('🔧 Final cleanup started');
  await fix1_fetchFileUrlFromFirestore();
  await fix2_aiRemainingFamilyMembers();
  await fix3_aiRemainingDocTypes();
  await fix4_fillUploadedAt();
  await fix5_fillContentType();
  console.log('\n🎉 All done!');
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
