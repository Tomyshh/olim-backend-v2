/**
 * Backfill remaining fields:
 *   A. Scan Firestore to find docs without firestore_id (match by type+who+date)
 *   B. Derive content_type from file_url
 *   C. Fill file_path from file_url (Firebase Storage path)
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

function initFirebase() {
  if (getApps().length) return;
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_JSON_BASE64 || '';
  const json = JSON.parse(Buffer.from(b64, 'base64').toString('utf-8'));
  initializeApp({ credential: cert(json) });
}

function normalize(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

function inferContentType(url: string): string {
  const lower = url.toLowerCase();
  if (lower.includes('.pdf')) return 'application/pdf';
  if (lower.includes('.png')) return 'image/png';
  if (lower.includes('.jpg') || lower.includes('.jpeg')) return 'image/jpeg';
  if (lower.includes('.gif')) return 'image/gif';
  if (lower.includes('.webp')) return 'image/webp';
  if (lower.includes('.heic')) return 'image/heic';
  if (lower.includes('.doc')) return 'application/msword';
  return 'application/octet-stream';
}

function extractFirebasePath(url: string): string | null {
  // Firebase Storage URL: https://firebasestorage.googleapis.com/v0/b/BUCKET/o/PATH?...
  const match = url.match(/\/o\/([^?]+)/);
  if (match) return decodeURIComponent(match[1]);
  return null;
}

// ────── A: Scan Firestore for docs without firestore_id ──────
async function scanFirestoreForMissing() {
  console.log('\n═══ A: Scan Firestore for docs without firestore_id ═══');
  initFirebase();
  const db = getFirestore();

  // Load all client mappings
  const clientMap = new Map<string, string>();
  let offset = 0;
  while (true) {
    const { data: clients } = await supabase.from('clients').select('id, firebase_uid').not('firebase_uid', 'is', null).range(offset, offset + 999);
    if (!clients?.length) break;
    for (const c of clients) clientMap.set(c.id, c.firebase_uid);
    if (clients.length < 1000) break;
    offset += 1000;
  }
  console.log(`  Loaded ${clientMap.size} client mappings`);

  // Get Supabase docs without firestore_id
  const missingByClient = new Map<string, any[]>();
  offset = 0;
  while (true) {
    const { data: docs } = await supabase
      .from('client_documents')
      .select('id, client_id, document_type, for_who, uploaded_at, file_url')
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
  console.log(`  ${totalMissing} docs missing firestore_id across ${missingByClient.size} clients`);

  let totalMatched = 0;
  let totalUnmatched = 0;
  let processedClients = 0;

  for (const [clientId, supaDocs] of missingByClient) {
    const uid = clientMap.get(clientId);
    if (!uid) { totalUnmatched += supaDocs.length; continue; }

    try {
      // Fetch ALL Firestore docs for this client
      const fsSnap = await db.collection('Clients').doc(uid).collection('Client Documents').get();
      const fsDocs = fsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

      // Build a set of already-matched firestore IDs
      const { data: existingDocs } = await supabase
        .from('client_documents')
        .select('firestore_id')
        .eq('client_id', clientId)
        .not('firestore_id', 'is', null);
      const matchedFsIds = new Set((existingDocs || []).map(d => d.firestore_id));

      for (const supaDoc of supaDocs) {
        // Try to match by document_type + for_who
        const supaType = normalize(supaDoc.document_type || '');
        const supaWho = normalize(supaDoc.for_who || '');

        let bestMatch: any = null;
        for (const fsDoc of fsDocs) {
          if (matchedFsIds.has(fsDoc.id)) continue;

          const fsType = normalize(fsDoc['Document Type'] || '');
          const fsWho = normalize(fsDoc['For who ?'] || '');

          if (supaType === fsType && supaWho === fsWho) {
            bestMatch = fsDoc;
            break;
          }
        }

        if (bestMatch) {
          matchedFsIds.add(bestMatch.id);
          const uploadedFiles: string[] = bestMatch['Uploaded Files'] || [];
          const fileUrl = uploadedFiles[0] || null;
          const fileName = fileUrl ? decodeURIComponent(fileUrl.split('/').pop()?.split('?')[0] || '') : null;
          const uploadDate = bestMatch['Upload date'] || null;

          const updateObj: Record<string, any> = { firestore_id: bestMatch.id };
          if (fileUrl && !supaDoc.file_url) {
            updateObj.file_url = fileUrl;
            updateObj.file_name = fileName;
          }
          if (uploadDate && typeof uploadDate === 'string' && uploadDate.includes('-')) {
            const parts = uploadDate.split('-');
            if (parts.length === 3 && parts[0].length <= 2) {
              updateObj.uploaded_at = `${parts[2]}-${parts[1]}-${parts[0]}T00:00:00.000Z`;
            }
          }
          if (uploadedFiles.length > 1) {
            updateObj.metadata = { firestoreId: bestMatch.id, uploadedFiles };
          } else {
            updateObj.metadata = {};
          }

          await supabase.from('client_documents').update(updateObj).eq('id', supaDoc.id);
          totalMatched++;
        } else {
          totalUnmatched++;
        }
      }
    } catch (err: any) {
      console.error(`  Error for client ${uid}:`, err.message?.substring(0, 80));
      totalUnmatched += supaDocs.length;
    }

    processedClients++;
    if (processedClients % 100 === 0) {
      console.log(`  Progress: ${processedClients}/${missingByClient.size} clients, matched ${totalMatched}`);
    }
  }

  console.log(`  ✅ Matched: ${totalMatched}, Unmatched: ${totalUnmatched}`);
}

// ────── B: Derive content_type + file_path from file_url ──────
async function deriveFromFileUrl() {
  console.log('\n═══ B: Derive content_type + file_path from file_url ═══');

  let offset = 0;
  let totalUpdated = 0;

  while (true) {
    const { data: docs } = await supabase
      .from('client_documents')
      .select('id, file_url')
      .not('file_url', 'is', null)
      .is('content_type', null)
      .range(offset, offset + 999);

    if (!docs?.length) break;

    const batchSize = 50;
    for (let i = 0; i < docs.length; i += batchSize) {
      const batch = docs.slice(i, i + batchSize);
      await Promise.all(batch.map(d => {
        const ct = inferContentType(d.file_url);
        const fp = extractFirebasePath(d.file_url);
        return supabase.from('client_documents').update({
          content_type: ct,
          file_path: fp,
        }).eq('id', d.id);
      }));
    }

    totalUpdated += docs.length;
    console.log(`  Processed ${totalUpdated} docs`);

    if (docs.length < 1000) break;
    offset += 1000;
  }

  console.log(`  ✅ Total updated: ${totalUpdated}`);
}

// ────── Main ──────
async function main() {
  console.log('🚀 Backfill remaining fields');
  await scanFirestoreForMissing();
  await deriveFromFileUrl();
  console.log('\n🎉 Done!');
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
