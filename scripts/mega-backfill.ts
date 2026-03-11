/**
 * Mega-backfill script for client_documents table.
 *
 * Steps:
 *   1. Extract firestoreId from metadata JSON → firestore_id column
 *   2. Read Firestore docs to fill file_url, file_name, uploaded_at from the real data
 *   3. Use OpenAI batch matching for document_type → document_type_id
 *   4. Backfill family_member_id from for_who
 *
 * Usage:
 *   OPENAI_API_KEY=sk-... npx tsx scripts/mega-backfill.ts [--dry-run] [--step=1,2,3,4]
 */

import * as dotenv from 'dotenv';
import * as path from 'path';
const root = process.cwd();
dotenv.config({ path: path.join(root, '.env.local'), override: true });
dotenv.config({ path: path.join(root, '.env') });
import { createClient } from '@supabase/supabase-js';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

// ────── Config ──────
const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SECRET_KEY || '';
const supabase = createClient(supabaseUrl, supabaseKey, { auth: { autoRefreshToken: false, persistSession: false } });

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const DRY_RUN = process.argv.includes('--dry-run');

// Parse --step flag
const stepArg = process.argv.find(a => a.startsWith('--step='));
const enabledSteps = stepArg ? stepArg.replace('--step=', '').split(',').map(Number) : [1, 2, 3, 4];

// Firebase Admin init
function initFirebase() {
  if (getApps().length) return;
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_JSON_BASE64 || '';
  if (!b64) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON_BASE64 missing');
  const json = JSON.parse(Buffer.from(b64, 'base64').toString('utf-8'));
  initializeApp({ credential: cert(json) });
}

function normalize(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

// ────── STEP 1: Extract firestoreId from metadata ──────
async function step1_extractFirestoreId() {
  console.log('\n═══ STEP 1: Extract firestoreId from metadata → firestore_id ═══');

  let offset = 0;
  const pageSize = 1000;
  let totalUpdated = 0;

  while (true) {
    const { data: docs, error } = await supabase
      .from('client_documents')
      .select('id, metadata')
      .is('firestore_id', null)
      .not('metadata', 'is', null)
      .range(offset, offset + pageSize - 1);

    if (error) { console.error('Error:', error.message); break; }
    if (!docs?.length) break;

    const updates: { id: string; firestore_id: string }[] = [];
    for (const doc of docs) {
      const meta = doc.metadata;
      const fsId = meta?.firestoreId || meta?.firestore_id;
      if (fsId) updates.push({ id: doc.id, firestore_id: fsId });
    }

    if (!DRY_RUN && updates.length) {
      // Batch update using individual updates (supabase doesn't support bulk upsert easily)
      const batchSize = 50;
      for (let i = 0; i < updates.length; i += batchSize) {
        const batch = updates.slice(i, i + batchSize);
        await Promise.all(batch.map(u =>
          supabase.from('client_documents').update({ firestore_id: u.firestore_id }).eq('id', u.id)
        ));
      }
    }

    totalUpdated += updates.length;
    console.log(`  Processed ${offset + docs.length} docs, extracted ${updates.length} firestoreIds`);

    if (docs.length < pageSize) break;
    offset += pageSize;
  }

  console.log(`  ✅ Total firestore_id extracted: ${totalUpdated}`);
}

// ────── STEP 2: Read Firestore to fill file_url, file_name, uploaded_at ──────
async function step2_fillFromFirestore() {
  console.log('\n═══ STEP 2: Read Firestore → fill file_url, file_name, uploaded_at ═══');
  initFirebase();
  const db = getFirestore();

  // Get all client_id → uid mappings (paginated)
  const clientMap = new Map<string, string>();
  let clientOffset = 0;
  while (true) {
    const { data: clients } = await supabase
      .from('clients')
      .select('id, firebase_uid')
      .not('firebase_uid', 'is', null)
      .range(clientOffset, clientOffset + 999);
    if (!clients?.length) break;
    for (const c of clients) clientMap.set(c.id, c.firebase_uid);
    if (clients.length < 1000) break;
    clientOffset += 1000;
  }
  console.log(`  Loaded ${clientMap.size} client→uid mappings`);

  // Get docs needing file_url
  let offset = 0;
  const pageSize = 500;
  let totalUpdated = 0;
  let totalSkipped = 0;

  while (true) {
    const { data: docs, error } = await supabase
      .from('client_documents')
      .select('id, client_id, firestore_id, file_url')
      .is('file_url', null)
      .not('firestore_id', 'is', null)
      .range(offset, offset + pageSize - 1);

    if (error) { console.error('Error:', error.message); break; }
    if (!docs?.length) break;

    // Group by client_id for efficiency
    const byClient = new Map<string, typeof docs>();
    for (const d of docs) {
      const list = byClient.get(d.client_id) || [];
      list.push(d);
      byClient.set(d.client_id, list);
    }

    for (const [clientId, clientDocs] of byClient) {
      const uid = clientMap.get(clientId);
      if (!uid) { totalSkipped += clientDocs.length; continue; }

      // Batch read from Firestore
      const firestoreIds = clientDocs.map(d => d.firestore_id!);
      const batchSize = 10;
      for (let i = 0; i < firestoreIds.length; i += batchSize) {
        const batch = firestoreIds.slice(i, i + batchSize);
        const refs = batch.map(fid => db.collection('Clients').doc(uid).collection('Client Documents').doc(fid));

        try {
          const snapshots = await db.getAll(...refs);
          for (let j = 0; j < snapshots.length; j++) {
            const snap = snapshots[j];
            const supaDoc = clientDocs[i + j];
            if (!snap.exists || !supaDoc) continue;

            const data = snap.data()!;
            // Firestore uses "Uploaded Files" (capital, space) or "uploadedFiles"
            const uploadedFiles: string[] = data['Uploaded Files'] || data['uploadedFiles'] || data['uploaded_files'] || [];
            const fileUrl = uploadedFiles[0] || null;
            const fileName = fileUrl ? decodeURIComponent(fileUrl.split('/').pop()?.split('?')[0] || '') : null;
            // Firestore uses "Upload date" (capital, space) or "uploadDate"
            const uploadDate = data['Upload date'] || data['uploadDate'] || data['upload_date'] || null;

            const updateObj: Record<string, any> = {};
            if (fileUrl) {
              updateObj.file_url = fileUrl;
              updateObj.file_name = fileName;
            }
            if (uploadDate) {
              if (typeof uploadDate === 'string' && uploadDate.includes('-')) {
                const parts = uploadDate.split('-');
                if (parts.length === 3 && parts[0].length <= 2) {
                  updateObj.uploaded_at = `${parts[2]}-${parts[1]}-${parts[0]}T00:00:00.000Z`;
                }
              }
            }

            // Store ALL uploadedFiles as JSON array in metadata for multi-file docs
            if (uploadedFiles.length > 1) {
              updateObj.metadata = { firestoreId: supaDoc.firestore_id, uploadedFiles };
            } else if (uploadedFiles.length <= 1) {
              // Clean metadata: remove firestoreId from metadata since we have it in firestore_id col
              updateObj.metadata = {};
            }

            if (Object.keys(updateObj).length && !DRY_RUN) {
              await supabase.from('client_documents').update(updateObj).eq('id', supaDoc.id);
              totalUpdated++;
            } else if (Object.keys(updateObj).length) {
              totalUpdated++;
            }
          }
        } catch (err: any) {
          console.error(`  Error reading Firestore for client ${uid}:`, err.message?.substring(0, 100));
        }
      }
    }

    console.log(`  Processed ${offset + docs.length} docs, updated ${totalUpdated}, skipped ${totalSkipped}`);
    if (docs.length < pageSize) break;
    offset += pageSize;
  }

  console.log(`  ✅ Total file_url filled from Firestore: ${totalUpdated}`);
}

// ────── STEP 3: OpenAI batch matching for document_type → document_type_id ──────
async function step3_openaiDocTypeMatching() {
  console.log('\n═══ STEP 3: OpenAI matching document_type → document_type_id ═══');

  if (!OPENAI_API_KEY) {
    console.error('  ❌ OPENAI_API_KEY not set. Skipping.');
    return;
  }

  // 1. Get the reference document_types
  const { data: docTypes } = await supabase.from('document_types').select('id, slug, label').limit(50);
  if (!docTypes?.length) { console.error('  No document_types found'); return; }

  // 2. Get all distinct unmatched document_type values
  const { data: unmatchedDocs } = await supabase
    .from('client_documents')
    .select('document_type')
    .is('document_type_id', null)
    .not('document_type', 'is', null)
    .limit(5000);

  const uniqueTypes = new Set<string>();
  for (const d of unmatchedDocs || []) {
    const t = (d.document_type || '').trim();
    if (t) uniqueTypes.add(t);
  }

  if (!uniqueTypes.size) {
    console.log('  All document_types already matched!');
    return;
  }

  console.log(`  ${uniqueTypes.size} unique unmatched document_type values to classify`);

  // 3. Call OpenAI to classify them all at once
  const refTable = docTypes.map(t => `"${t.slug}": "${t.label}"`).join('\n');
  const unmatchedList = [...uniqueTypes].map((t, i) => `${i + 1}. "${t}"`).join('\n');

  const prompt = `Tu es un assistant de classification de documents pour une application d'immigration en Israël.

Voici la table de référence des types de documents (slug: label):
${refTable}

Voici une liste de types de documents tels qu'ils apparaissent dans les données existantes. Pour chacun, donne le slug qui correspond le mieux.
Si aucun ne correspond, utilise "autre".
Si c'est clairement un document joint à une demande administrative (pas un document personnel), utilise "request_attachment".

IMPORTANT: Réponds UNIQUEMENT avec un JSON valide, sans markdown, sans explication.
Format: {"résultats": [{"input": "...", "slug": "..."}]}

Types de documents à classifier:
${unmatchedList}`;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
        max_tokens: 4096,
      }),
    });

    const json = await response.json();
    const content = json.choices?.[0]?.message?.content || '';

    // Parse JSON response
    let mappings: { input: string; slug: string }[] = [];
    try {
      const cleaned = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const parsed = JSON.parse(cleaned);
      mappings = parsed.résultats || parsed.resultats || parsed.results || [];
    } catch (e) {
      console.error('  Failed to parse OpenAI response:', content.substring(0, 300));
      return;
    }

    console.log(`  OpenAI returned ${mappings.length} mappings`);

    // Build slug → id map
    const slugToId = new Map<string, string>();
    for (const t of docTypes) {
      slugToId.set(t.slug, t.id);
    }

    // Apply mappings
    let totalUpdated = 0;
    for (const m of mappings) {
      const typeId = slugToId.get(m.slug);
      if (!typeId) {
        console.log(`  ⚠️ Unknown slug: ${m.slug} for "${m.input}"`);
        continue;
      }

      if (!DRY_RUN) {
        const { error, count } = await supabase
          .from('client_documents')
          .update({ document_type_id: typeId })
          .eq('document_type', m.input)
          .is('document_type_id', null);

        if (error) {
          console.error(`  Error updating "${m.input}":`, error.message);
        } else {
          totalUpdated += count || 0;
          console.log(`  ✅ "${m.input}" → ${m.slug} (${count} rows)`);
        }
      } else {
        console.log(`  [DRY] "${m.input}" → ${m.slug}`);
        totalUpdated++;
      }
    }

    console.log(`  ✅ Total document_type_id updated via OpenAI: ${totalUpdated}`);
  } catch (err: any) {
    console.error('  OpenAI API error:', err.message);
  }
}

// ────── STEP 4: Backfill family_member_id from for_who ──────
async function step4_backfillFamilyMemberId() {
  console.log('\n═══ STEP 4: Backfill family_member_id from for_who ═══');

  let offset = 0;
  const pageSize = 1000;
  let totalUpdated = 0;
  let totalNoMatch = 0;

  // Preload all family_members
  const allMembers: any[] = [];
  let memOffset = 0;
  while (true) {
    const { data: members } = await supabase
      .from('family_members')
      .select('id, client_id, first_name, last_name')
      .range(memOffset, memOffset + 999);
    if (!members?.length) break;
    allMembers.push(...members);
    if (members.length < 1000) break;
    memOffset += 1000;
  }
  console.log(`  Loaded ${allMembers.length} family members`);

  // Index by client_id
  const membersByClient = new Map<string, typeof allMembers>();
  for (const m of allMembers) {
    const list = membersByClient.get(m.client_id) || [];
    list.push(m);
    membersByClient.set(m.client_id, list);
  }

  while (true) {
    const { data: docs, error } = await supabase
      .from('client_documents')
      .select('id, client_id, for_who')
      .is('family_member_id', null)
      .not('for_who', 'is', null)
      .neq('for_who', '')
      .range(offset, offset + pageSize - 1);

    if (error) { console.error('Error:', error.message); break; }
    if (!docs?.length) break;

    const updates: { id: string; family_member_id: string }[] = [];

    for (const doc of docs) {
      const forWho = normalize(doc.for_who);
      if (!forWho) continue;

      const clientMembers = membersByClient.get(doc.client_id) || [];
      let matched: any = null;

      // If for_who contains commas, try to match the first name
      const names = forWho.includes(',') ? forWho.split(',').map(s => s.trim()) : [forWho];

      for (const name of names) {
        if (!name) continue;
        for (const m of clientMembers) {
          const fn = normalize(m.first_name ?? '');
          const ln = normalize(m.last_name ?? '');
          const full = `${fn} ${ln}`.trim();
          const fullR = `${ln} ${fn}`.trim();

          if (name === full || name === fullR || full.includes(name) || name.includes(full)
            || (fn && ln && name.includes(fn) && name.includes(ln))) {
            matched = m;
            break;
          }
        }
        if (matched) break;
      }

      if (matched) {
        updates.push({ id: doc.id, family_member_id: matched.id });
      } else {
        totalNoMatch++;
      }
    }

    if (!DRY_RUN && updates.length) {
      const batchSize = 50;
      for (let i = 0; i < updates.length; i += batchSize) {
        const batch = updates.slice(i, i + batchSize);
        await Promise.all(batch.map(u =>
          supabase.from('client_documents').update({ family_member_id: u.family_member_id }).eq('id', u.id)
        ));
      }
    }

    totalUpdated += updates.length;
    console.log(`  Processed ${offset + docs.length} docs, matched ${updates.length}`);
    if (docs.length < pageSize) break;
    offset += pageSize;
  }

  console.log(`  ✅ Total family_member_id updated: ${totalUpdated}`);
  console.log(`  ❌ No match found: ${totalNoMatch}`);
}

// ────── MAIN ──────
async function main() {
  console.log(`\n🚀 Mega-backfill script started (dry-run: ${DRY_RUN}, steps: ${enabledSteps.join(',')})`);

  if (enabledSteps.includes(1)) await step1_extractFirestoreId();
  if (enabledSteps.includes(2)) await step2_fillFromFirestore();
  if (enabledSteps.includes(3)) await step3_openaiDocTypeMatching();
  if (enabledSteps.includes(4)) await step4_backfillFamilyMemberId();

  console.log('\n🎉 Done!');
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
