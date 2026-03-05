/**
 * count-requests-assigned-to-annaelle.ts
 * ─────────────────────────────────────
 * Lit toutes les demandes (Requests) de tous les clients et compte celles
 * assignées à "Annaelle". LECTURE SEULE - aucune modification.
 *
 * Usage:
 *   tsx scripts/count-requests-assigned-to-annaelle.ts
 */

import dotenv from 'dotenv';
import path from 'path';
import type { QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { admin, initializeFirebase, getFirestore } from '../src/config/firebase.js';

dotenv.config();
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const ASSIGNED_TO = 'Anaelle';

async function main(): Promise<void> {
  console.log('[count-requests-assigned-to-annaelle] Initialisation Firebase...');
  initializeFirebase();
  const db = getFirestore();

  const results: Array<{
    clientId: string;
    requestId: string;
    status?: string;
    requestType?: string;
    requestCategory?: string;
    requestDate?: unknown;
  }> = [];

  // Stratégie 1: collectionGroup si index disponible
  try {
    const snap = await db.collectionGroup('Requests').where('Assigned to', '==', ASSIGNED_TO).get();
    for (const doc of snap.docs) {
      const data = doc.data() as Record<string, unknown>;
      const pathParts = doc.ref.path.split('/');
      const clientId = pathParts[1] ?? '?';
      const requestId = doc.id;
      results.push({
        clientId,
        requestId,
        status: String(data?.Status ?? data?.status ?? ''),
        requestType: String(data?.['Request Type'] ?? ''),
        requestCategory: String(data?.['Request Category'] ?? ''),
        requestDate: data?.['Request Date'] ?? data?.request_date
      });
    }
    console.log('[count-requests-assigned-to-annaelle] collectionGroup OK,', snap.size, 'demandes trouvées');
  } catch (err: unknown) {
    console.warn('[count-requests-assigned-to-annaelle] collectionGroup échoué (index manquant?), fallback itératif...', err);
    // Stratégie 2: itération client par client
    const docIdField = admin.firestore.FieldPath.documentId();
    const pageSize = 250;
    let lastDoc: QueryDocumentSnapshot | null = null;
    const allClientIds: string[] = [];

    do {
      let q = db.collection('Clients').orderBy(docIdField).limit(pageSize);
      if (lastDoc) q = q.startAfter(lastDoc);
      const snap = await q.get();
      for (const d of snap.docs) allClientIds.push(d.id);
      if (snap.docs.length > 0) lastDoc = snap.docs[snap.docs.length - 1]!;
      if (snap.docs.length < pageSize) break;
    } while (true);

    console.log('[count-requests-assigned-to-annaelle]', allClientIds.length, 'clients à scanner');

    const batchSize = 50;
    for (let i = 0; i < allClientIds.length; i += batchSize) {
      const batch = allClientIds.slice(i, i + batchSize);
      const reqs = await Promise.all(
        batch.map(async (clientId) => {
          const reqSnap = await db
            .collection('Clients')
            .doc(clientId)
            .collection('Requests')
            .where('Assigned to', '==', ASSIGNED_TO)
            .get();
          return reqSnap.docs.map((d) => {
            const data = d.data() as Record<string, unknown>;
            return {
              clientId,
              requestId: d.id,
              status: String(data?.Status ?? data?.status ?? ''),
              requestType: String(data?.['Request Type'] ?? ''),
              requestCategory: String(data?.['Request Category'] ?? ''),
              requestDate: data?.['Request Date'] ?? data?.request_date
            };
          });
        })
      );
      for (const arr of reqs) results.push(...arr);
      if ((i + batch.length) % 500 === 0) {
        console.log('[count-requests-assigned-to-annaelle] scanné', Math.min(i + batchSize, allClientIds.length), '/', allClientIds.length);
      }
    }
  }

  console.log('\n' + '─'.repeat(60));
  console.log('[count-requests-assigned-to-annaelle] RÉSULTAT');
  console.log('─'.repeat(60));
  console.log('Nombre total de demandes assignées à "' + ASSIGNED_TO + '":', results.length);
  console.log('─'.repeat(60));

  if (results.length > 0) {
    console.log('\nAperçu (10 premières):');
    for (const r of results.slice(0, 10)) {
      console.log('  -', r.clientId, '|', r.requestId, '|', r.status, '|', r.requestType, r.requestCategory);
    }
  }
}

main().catch((e) => {
  console.error('[count-requests-assigned-to-annaelle] Erreur:', String(e?.message ?? e));
  process.exit(1);
});
