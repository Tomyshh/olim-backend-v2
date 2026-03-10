/**
 * Migration script: adds `assigned_to_uid` to every Firestore Request document
 * by matching the existing `Assigned to` (name string) against Conseillers2.
 *
 * Usage:
 *   npx tsx src/scripts/migrate-assigned-to-uid.ts          # dry-run (default)
 *   npx tsx src/scripts/migrate-assigned-to-uid.ts --apply   # actually write
 */

import { initializeFirebase, getFirestore } from '../config/firebase.js';

const DRY_RUN = !process.argv.includes('--apply');

async function main() {
  initializeFirebase();
  const db = getFirestore();

  console.log(`\n🔄 Migration assigned_to_uid  (${DRY_RUN ? 'DRY RUN' : 'APPLY MODE'})\n`);

  const conseillersSnap = await db.collection('Conseillers2').get();
  const nameToUid = new Map<string, string>();
  for (const doc of conseillersSnap.docs) {
    const name: string = doc.data().name ?? '';
    if (name) {
      nameToUid.set(name.toLowerCase().trim(), doc.id);
    }
  }
  console.log(`📋 ${nameToUid.size} conseillers loaded\n`);

  const requestsSnap = await db.collectionGroup('Requests').get();
  console.log(`📦 ${requestsSnap.size} request documents found\n`);

  let updated = 0;
  let skipped = 0;
  let notFound = 0;
  const batch = db.batch();
  const MAX_BATCH = 500;

  for (const doc of requestsSnap.docs) {
    const data = doc.data();

    if (data.assigned_to_uid) {
      skipped++;
      continue;
    }

    const assignedTo: string = data['Assigned to'] ?? '';
    if (!assignedTo.trim()) {
      skipped++;
      continue;
    }

    const uid = nameToUid.get(assignedTo.toLowerCase().trim());
    if (!uid) {
      notFound++;
      console.log(`  ⚠️  No match for "${assignedTo}" (request ${doc.id})`);
      continue;
    }

    if (!DRY_RUN) {
      batch.update(doc.ref, { assigned_to_uid: uid });
    }
    updated++;

    if (!DRY_RUN && updated % MAX_BATCH === 0) {
      await batch.commit();
      console.log(`  ✅ Committed batch of ${MAX_BATCH}`);
    }
  }

  if (!DRY_RUN && updated % MAX_BATCH !== 0) {
    await batch.commit();
  }

  console.log(`\n--- Summary ---`);
  console.log(`  Updated:   ${updated}`);
  console.log(`  Skipped:   ${skipped} (already had uid or no assignee)`);
  console.log(`  Not found: ${notFound} (name not matching any conseiller)`);
  console.log(`  Total:     ${requestsSnap.size}\n`);

  if (DRY_RUN) {
    console.log('ℹ️  This was a dry run. Pass --apply to write changes.\n');
  } else {
    console.log('✅ Migration complete.\n');
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('❌ Migration failed:', err);
  process.exit(1);
});
