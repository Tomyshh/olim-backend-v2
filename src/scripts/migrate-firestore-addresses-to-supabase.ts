/**
 * Migre toutes les adresses Firestore (Clients/{uid}/Addresses/*)
 * vers la table Supabase `client_addresses`.
 *
 * - NE TOUCHE JAMAIS A FIRESTORE (lecture seule).
 * - Upsert dans Supabase (on conflict client_id + firestore_id).
 * - Lie automatiquement les family_members dont lives_at_home = false
 *   à l'adresse primaire du client (address_id reste NULL = convention).
 *
 * Usage:
 *   npx tsx src/scripts/migrate-firestore-addresses-to-supabase.ts          # dry-run
 *   npx tsx src/scripts/migrate-firestore-addresses-to-supabase.ts --apply  # execute
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
const supabaseKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const DRY_RUN = !process.argv.includes('--apply');

function pickStr(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function toIso(v: unknown): string | null {
  if (!v) return null;
  if (typeof v === 'string') return v;
  if (typeof (v as any).toDate === 'function') return (v as any).toDate().toISOString();
  if (v instanceof Date) return v.toISOString();
  if (typeof (v as any)._seconds === 'number') return new Date((v as any)._seconds * 1000).toISOString();
  return null;
}

function mapFirestoreAddressToSupabase(
  clientSupabaseId: string,
  addressId: string,
  fs: Record<string, any>
): Record<string, any> {
  return {
    client_id: clientSupabaseId,
    firestore_id: addressId,
    label: pickStr(fs.Name) ?? pickStr(fs.name) ?? pickStr(fs.label),
    name: pickStr(fs.Name) ?? pickStr(fs.name),
    address1: pickStr(fs.Address) ?? pickStr(fs.address),
    address2: pickStr(fs['Additional address']) ?? pickStr(fs.additionalInfo),
    additional_info: pickStr(fs.additionalInfo) ?? pickStr(fs['Additional address']),
    apartment: pickStr(fs.Appartment) ?? pickStr(fs.apartment),
    floor: pickStr(fs.Etage) ?? pickStr(fs.floor),
    details: pickStr(fs.details) ?? null,
    is_primary: addressId === 'primary' || fs.isPrimary === true,
    is_active: fs.isActive ?? true,
    is_current_residence: addressId === 'primary' || fs.isCurrentResidence === true,
    order_index: typeof fs.orderIndex === 'number' ? fs.orderIndex : 0,
    deactivated_at: toIso(fs.deactivatedAt),
    attachments: Array.isArray(fs.attachments) ? JSON.stringify(fs.attachments) : '[]',
    payment_info: fs.paymentInfo ? JSON.stringify(fs.paymentInfo) : null,
    entry_date: pickStr(fs.entryDate),
    exit_date: pickStr(fs.exitDate),
    metadata: {},
    created_at: toIso(fs.createdAt) ?? new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

async function main() {
  console.log(`\n=== Migration Firestore Addresses → Supabase ===`);
  console.log(`Mode: ${DRY_RUN ? 'DRY-RUN (aucune ecriture)' : 'APPLY (ecriture reelle)'}\n`);

  initializeFirebase();
  const db = getFirestore();

  const clientsSnap = await db.collection('Clients').get();
  console.log(`Clients Firestore trouves: ${clientsSnap.size}`);

  let totalAddresses = 0;
  let migrated = 0;
  let skippedNoAddr = 0;
  let skippedNoSupabase = 0;
  let errors = 0;

  const clientCache = new Map<string, string>();

  let from = 0;
  const PAGE = 1000;
  while (true) {
    const { data: page } = await supabase
      .from('clients')
      .select('id, firebase_uid')
      .range(from, from + PAGE - 1);
    if (!page || page.length === 0) break;
    for (const c of page) {
      if (c.firebase_uid) clientCache.set(c.firebase_uid, c.id);
    }
    if (page.length < PAGE) break;
    from += PAGE;
  }
  console.log(`Cache Supabase clients: ${clientCache.size} entries\n`);

  for (const clientDoc of clientsSnap.docs) {
    const firebaseUid = clientDoc.id;

    const addrSnap = await db
      .collection('Clients')
      .doc(firebaseUid)
      .collection('Addresses')
      .get();

    if (addrSnap.empty) {
      skippedNoAddr++;
      continue;
    }

    const supabaseClientId = clientCache.get(firebaseUid);
    if (!supabaseClientId) {
      skippedNoSupabase++;
      continue;
    }

    const hasPrimaryDoc = addrSnap.docs.some(d => d.id === 'primary');
    const onlyOneAddress = addrSnap.docs.length === 1;

    for (const addrDoc of addrSnap.docs) {
      totalAddresses++;
      const addrData = addrDoc.data();
      const row = mapFirestoreAddressToSupabase(supabaseClientId, addrDoc.id, addrData);

      if (!hasPrimaryDoc && onlyOneAddress) {
        row.is_primary = true;
        row.is_current_residence = true;
      }

      if (DRY_RUN) {
        const label = row.name || row.label || addrDoc.id;
        console.log(
          `  [DRY] ${firebaseUid} → addr "${label}" | ${row.address1 ?? '(vide)'} | primary=${row.is_primary} | active=${row.is_active}`
        );
        migrated++;
        continue;
      }

      const { data: existing } = await supabase
        .from('client_addresses')
        .select('id')
        .eq('client_id', supabaseClientId)
        .eq('firestore_id', addrDoc.id)
        .maybeSingle();

      if (row.is_primary && !existing?.id) {
        await supabase
          .from('client_addresses')
          .update({ is_primary: false })
          .eq('client_id', supabaseClientId)
          .eq('is_primary', true);
      }

      let writeError: any = null;
      if (existing?.id) {
        const { error } = await supabase
          .from('client_addresses')
          .update(row)
          .eq('id', existing.id);
        writeError = error;
      } else {
        const { error } = await supabase
          .from('client_addresses')
          .insert(row);
        writeError = error;
      }

      if (writeError) {
        console.error(`  [ERR] ${firebaseUid}/${addrDoc.id}: ${writeError.message}`);
        errors++;
      } else {
        migrated++;
      }
    }
  }

  if (!DRY_RUN) {
    console.log(`\nMise à jour is_current_residence pour les adresses primaires...`);
    const { error: resErr } = await supabase
      .from('client_addresses')
      .update({ is_current_residence: true })
      .eq('is_primary', true)
      .eq('is_current_residence', false);
    if (resErr) console.error(`  [ERR] is_current_residence: ${resErr.message}`);
    else console.log(`  [OK] is_current_residence mis à jour`);
  }

  console.log(`\n=== Resultats ===`);
  console.log(`Adresses trouvees: ${totalAddresses}`);
  console.log(`Migrees/upsertees: ${migrated}`);
  console.log(`Clients sans adresse: ${skippedNoAddr}`);
  console.log(`Clients sans correspondance Supabase: ${skippedNoSupabase}`);
  console.log(`Erreurs: ${errors}`);
  if (DRY_RUN) console.log(`\n→ Relancer avec --apply pour executer reellement.`);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
