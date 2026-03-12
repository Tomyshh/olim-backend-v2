/**
 * AI-powered deep backfill: use OpenAI to resolve ALL remaining gaps.
 *
 * 1. family_member_id: batch per-client, send for_who + members to OpenAI
 * 2. Relaxed Firestore scan: match docs by partial criteria
 * 3. Fill remaining content_type, uploaded_at
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

// ────── OpenAI helper ──────
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

// ────── STEP 1: OpenAI family_member_id matching ──────
async function step1_aiFamilyMemberMatching() {
  console.log('\n═══ STEP 1: OpenAI family_member_id matching ═══');

  // Load ALL family members
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
  console.log(`  Loaded ${allMembers.length} family members across ${membersByClient.size} clients`);

  // Load unmatched docs grouped by client
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

  const totalUnmatched = [...unmatchedByClient.values()].reduce((s, l) => s + l.length, 0);
  console.log(`  ${totalUnmatched} docs unmatched across ${unmatchedByClient.size} clients`);

  const clientIds = [...unmatchedByClient.keys()];
  let totalUpdated = 0;
  let totalNoMatch = 0;
  let totalSkipped = 0;

  // Process 1 client at a time for reliability, with concurrency
  const CONCURRENCY = 5;

  async function processClient(clientId: string, idx: number) {
    const docs = unmatchedByClient.get(clientId) || [];
    const members = membersByClient.get(clientId) || [];

    if (!members.length) {
      totalNoMatch += docs.length;
      return;
    }

    const uniqueForWho = [...new Set(docs.map(d => d.for_who.trim()))];

    // Use short index instead of full UUID to reduce prompt size
    const memberEntries = members.map((m, i) => ({ idx: i + 1, id: m.id, label: `${m.first_name || ''} ${m.last_name || ''}`.trim() }));
    const memberList = memberEntries.map(e => `${e.idx}. ${e.label}`).join('\n');
    const forWhoList = uniqueForWho.map((w, j) => `${j + 1}. "${w}"`).join('\n');

    const prompt = `Match each document name to a family member.
Members:
${memberList}

Documents (for_who):
${forWhoList}

Rules:
- Multiple names separated by comma? Take FIRST name
- Extra spaces, accents, case: ignore
- "Général", "test", non-names → null
- Partial first name matching one member → match it

Reply ONLY valid JSON (no markdown):
[{"fw": 1, "m": 3}, {"fw": 2, "m": null}]
fw = document number, m = member number or null`;

    try {
      const content = await callOpenAI(prompt, 2048);
      const cleaned = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const matches: { fw: number; m: number | null }[] = JSON.parse(cleaned);

      for (const match of matches) {
        const forWhoValue = uniqueForWho[match.fw - 1];
        if (!forWhoValue) continue;

        const matchingDocs = docs.filter(d => d.for_who.trim() === forWhoValue);

        if (!match.m || !memberEntries[match.m - 1]) {
          totalNoMatch += matchingDocs.length;
          continue;
        }

        const memberId = memberEntries[match.m - 1].id;
        const ids = matchingDocs.map(d => d.id);
        await Promise.all(ids.map(id =>
          supabase.from('client_documents').update({ family_member_id: memberId }).eq('id', id)
        ));
        totalUpdated += matchingDocs.length;
      }
    } catch (err: any) {
      totalSkipped += docs.length;
      if (!err.message?.includes('abort')) {
        console.error(`  Client ${idx} error:`, err.message?.substring(0, 80));
      }
    }
  }

  // Run with concurrency pool
  for (let i = 0; i < clientIds.length; i += CONCURRENCY) {
    const batch = clientIds.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map((cid, j) => processClient(cid, i + j)));
    if ((i + CONCURRENCY) % 50 === 0 || i + CONCURRENCY >= clientIds.length) {
      console.log(`  Progress: ${Math.min(i + CONCURRENCY, clientIds.length)}/${clientIds.length} clients | updated: ${totalUpdated} | no-match: ${totalNoMatch} | errors: ${totalSkipped}`);
    }
  }

  console.log(`  ✅ Total updated: ${totalUpdated}`);
  console.log(`  ❌ No match: ${totalNoMatch}`);
}

// ────── STEP 2: Relaxed Firestore scan ──────
async function step2_relaxedFirestoreScan() {
  console.log('\n═══ STEP 2: Relaxed Firestore scan for missing firestore_id + file_url ═══');
  initFirebase();
  const db = getFirestore();

  // Load client mappings
  const clientMap = new Map<string, string>();
  let cOffset = 0;
  while (true) {
    const { data } = await supabase.from('clients').select('id, firebase_uid').not('firebase_uid', 'is', null).range(cOffset, cOffset + 999);
    if (!data?.length) break;
    for (const c of data) clientMap.set(c.id, c.firebase_uid);
    if (data.length < 1000) break;
    cOffset += 1000;
  }

  // Group docs without firestore_id by client
  const missingByClient = new Map<string, any[]>();
  let offset = 0;
  while (true) {
    const { data: docs } = await supabase
      .from('client_documents')
      .select('id, client_id, document_type, for_who, uploaded_at')
      .is('firestore_id', null)
      .range(offset, offset + 999);
    if (!docs?.length) break;
    for (const d of docs) {
      const list = missingByClient.get(d.client_id) || [];
      list.push(d);
      missingByClient.set(d.client_id, list);
    }
    if (docs.length < 1000) break;
    offset += 1000;
  }

  const totalMissing = [...missingByClient.values()].reduce((s, l) => s + l.length, 0);
  console.log(`  ${totalMissing} docs missing across ${missingByClient.size} clients`);

  let totalMatched = 0;
  let processed = 0;

  for (const [clientId, supaDocs] of missingByClient) {
    const uid = clientMap.get(clientId);
    if (!uid) continue;

    try {
      const fsSnap = await db.collection('Clients').doc(uid).collection('Client Documents').get();
      if (fsSnap.empty) continue;

      // Get already-matched IDs
      const { data: matched } = await supabase
        .from('client_documents')
        .select('firestore_id')
        .eq('client_id', clientId)
        .not('firestore_id', 'is', null);
      const usedIds = new Set((matched || []).map(d => d.firestore_id));

      const availableFsDocs = fsSnap.docs.filter(d => !usedIds.has(d.id)).map(d => ({ id: d.id, ...d.data() }));

      for (const supaDoc of supaDocs) {
        // Try relaxed matching: type only, or who only
        const supaType = (supaDoc.document_type || '').toLowerCase().trim();
        const supaWho = (supaDoc.for_who || '').toLowerCase().trim();

        let bestMatch: any = null;

        // Pass 1: match by type + partial who
        for (const fsDoc of availableFsDocs) {
          if (usedIds.has(fsDoc.id)) continue;
          const fsType = (fsDoc['Document Type'] || '').toLowerCase().trim();
          const fsWho = (fsDoc['For who ?'] || '').toLowerCase().trim();
          if (supaType === fsType && supaWho && fsWho && (fsWho.includes(supaWho.split(',')[0].trim()) || supaWho.includes(fsWho.split(',')[0].trim()))) {
            bestMatch = fsDoc;
            break;
          }
        }

        // Pass 2: match by type only (if only one unmatched doc of this type)
        if (!bestMatch) {
          const sameType = availableFsDocs.filter(f => !usedIds.has(f.id) && (f['Document Type'] || '').toLowerCase().trim() === supaType);
          if (sameType.length === 1) bestMatch = sameType[0];
        }

        if (bestMatch) {
          usedIds.add(bestMatch.id);
          const uploadedFiles: string[] = bestMatch['Uploaded Files'] || [];
          const fileUrl = uploadedFiles[0] || null;
          const fileName = fileUrl ? decodeURIComponent(fileUrl.split('/').pop()?.split('?')[0] || '') : null;

          const updateObj: Record<string, any> = { firestore_id: bestMatch.id };
          if (fileUrl) { updateObj.file_url = fileUrl; updateObj.file_name = fileName; }
          if (uploadedFiles.length > 1) {
            updateObj.metadata = { firestoreId: bestMatch.id, uploadedFiles };
          } else {
            updateObj.metadata = {};
          }

          await supabase.from('client_documents').update(updateObj).eq('id', supaDoc.id);
          totalMatched++;
        }
      }
    } catch (err: any) {
      // skip errors
    }

    processed++;
    if (processed % 100 === 0) console.log(`  Progress: ${processed}/${missingByClient.size} clients, matched ${totalMatched}`);
  }

  console.log(`  ✅ Matched: ${totalMatched}`);
}

// ────── STEP 3: Fill remaining gaps ──────
async function step3_fillRemainingGaps() {
  console.log('\n═══ STEP 3: Fill remaining content_type + uploaded_at ═══');

  // 3a. content_type from file_url
  let offset = 0;
  let ctUpdated = 0;
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
      const fp = l.includes('/o/') ? decodeURIComponent((d.file_url.match(/\/o\/([^?]+)/)?.[1]) || '') : d.file_url;
      return supabase.from('client_documents').update({ content_type: ct, file_path: fp }).eq('id', d.id);
    }));
    ctUpdated += docs.length;
    if (docs.length < 1000) break;
    offset += 1000;
  }
  console.log(`  content_type filled: ${ctUpdated}`);

  // 3b. uploaded_at: set to created_at for docs still missing it
  const { error } = await supabase.rpc('backfill_uploaded_at', {});
  // If RPC doesn't exist, do it manually
  offset = 0;
  let dateUpdated = 0;
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
    dateUpdated += docs.length;
    if (docs.length < 1000) break;
    offset += 1000;
  }
  console.log(`  uploaded_at filled from created_at: ${dateUpdated}`);
}

// ────── MAIN ──────
async function main() {
  console.log('🧠 AI Deep Backfill started');

  const stepArg = process.argv.find(a => a.startsWith('--step='));
  const steps = stepArg ? stepArg.replace('--step=', '').split(',').map(Number) : [1, 2, 3];

  if (steps.includes(1)) await step1_aiFamilyMemberMatching();
  if (steps.includes(2)) await step2_relaxedFirestoreScan();
  if (steps.includes(3)) await step3_fillRemainingGaps();

  console.log('\n🎉 Done!');
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
