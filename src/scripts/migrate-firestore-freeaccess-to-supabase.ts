/**
 * Migre les champs freeAccess de tous les clients Firestore
 * vers la colonne free_access (JSONB) de la table Supabase `clients`.
 *
 * - NE TOUCHE JAMAIS A FIRESTORE (lecture seule).
 * - Met a jour la colonne free_access dans Supabase.
 *
 * Usage:
 *   npx tsx src/scripts/migrate-firestore-freeaccess-to-supabase.ts          # dry-run
 *   npx tsx src/scripts/migrate-firestore-freeaccess-to-supabase.ts --apply  # execute
 */

import 'dotenv/config';
import dotenv from 'dotenv';
import path from 'path';

if (process.env.NODE_ENV !== 'production') {
  dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
}

import { createClient } from '@supabase/supabase-js';
import { initializeFirebase, getFirestore } from '../config/firebase.js';

const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || '';
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const DRY_RUN = !process.argv.includes('--apply');

function tsToIso(val: any): string | null {
  if (!val) return null;
  if (typeof val.toDate === 'function') return val.toDate().toISOString();
  if (val._seconds != null) return new Date(val._seconds * 1000).toISOString();
  if (typeof val === 'string') return val;
  return null;
}

async function main() {
  console.log(`\n=== Migration freeAccess Firestore -> Supabase ===`);
  console.log(`Mode: ${DRY_RUN ? 'DRY-RUN (ajoutez --apply pour executer)' : 'APPLY'}\n`);

  initializeFirebase();
  const db = getFirestore();

  const clientsSnap = await db.collection('Clients').get();
  console.log(`Nombre total de clients Firestore: ${clientsSnap.size}`);

  let migrated = 0;
  let skipped = 0;
  let errors = 0;

  for (const doc of clientsSnap.docs) {
    const uid = doc.id;
    const data = doc.data();

    if (!data.freeAccess) {
      skipped++;
      continue;
    }

    const fa = data.freeAccess;
    const supabaseFreeAccess: Record<string, any> = {
      isEnabled: fa.isEnabled === true,
      membership: fa.membership || '',
      reason: fa.reason || '',
      notes: fa.notes || '',
      isFirstVisit: fa.isFirstVisit ?? false,
    };

    const grantedAt = tsToIso(fa.grantedAt);
    if (grantedAt) supabaseFreeAccess.grantedAt = grantedAt;

    const expiresAt = tsToIso(fa.expiresAt);
    if (expiresAt) supabaseFreeAccess.expiresAt = expiresAt;

    const grantedBy = fa.grantedBy || null;
    if (grantedBy) supabaseFreeAccess.grantedBy = grantedBy;

    if (DRY_RUN) {
      console.log(`[DRY-RUN] ${uid}: freeAccess =`, JSON.stringify(supabaseFreeAccess));
      migrated++;
      continue;
    }

    const { error } = await supabase
      .from('clients')
      .update({ free_access: supabaseFreeAccess, updated_at: new Date().toISOString() })
      .eq('firebase_uid', uid);

    if (error) {
      console.error(`[ERROR] ${uid}:`, error.message);
      errors++;
    } else {
      console.log(`[OK] ${uid}: freeAccess migre (isEnabled=${supabaseFreeAccess.isEnabled}, membership=${supabaseFreeAccess.membership})`);
      migrated++;
    }
  }

  console.log(`\n=== Resultat ===`);
  console.log(`Migres: ${migrated}`);
  console.log(`Ignores (pas de freeAccess): ${skipped}`);
  console.log(`Erreurs: ${errors}`);
}

main().catch((err) => {
  console.error('Erreur fatale:', err);
  process.exit(1);
});
