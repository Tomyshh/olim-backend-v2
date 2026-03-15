/**
 * Migre toutes les subscriptions Firestore (Clients/{uid}/subscription/current)
 * vers la table Supabase `subscriptions`.
 *
 * - NE TOUCHE JAMAIS A FIRESTORE (lecture seule).
 * - Upsert dans Supabase (on conflict client_id).
 *
 * Usage:
 *   npx tsx src/scripts/migrate-firestore-subscriptions-to-supabase.ts          # dry-run
 *   npx tsx src/scripts/migrate-firestore-subscriptions-to-supabase.ts --apply  # execute
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

function mapFirestoreSubToSupabase(clientSupabaseId: string, fs: Record<string, any>): Record<string, any> {
  const planType = pickStr(fs.plan?.type) ?? pickStr(fs.planType) ?? null;
  const membershipType = pickStr(fs.plan?.membership) ?? pickStr(fs.membershipType) ?? null;

  return {
    client_id: clientSupabaseId,
    plan_type: planType,
    membership_type: membershipType,
    price_cents: fs.plan?.price ?? fs.priceInCents ?? null,
    base_price_cents: fs.plan?.basePriceInCents ?? fs.basePriceInCents ?? null,
    currency: pickStr(fs.plan?.currency) ?? 'ILS',
    payment_method: pickStr(fs.payment?.method) ?? null,
    installments: fs.payment?.installments ?? null,
    next_payment_at: toIso(fs.payment?.nextPaymentDate),
    last_payment_at: toIso(fs.payment?.lastPaymentDate),
    payme_sub_code: fs.payme?.subCode ?? null,
    payme_sub_id: pickStr(fs.payme?.subID) ?? null,
    payme_buyer_key: pickStr(fs.payme?.buyerKey) ?? null,
    payme_status: typeof fs.payme?.status === 'number' ? String(fs.payme.status) : (pickStr(fs.payme?.status) ?? null),
    payme_sub_status: typeof fs.payme?.status === 'number' ? fs.payme.status : (fs.payme?.subStatus ?? null),
    is_unpaid: fs.isUnpaid ?? fs.states?.isUnpaid ?? false,
    is_active: fs.states?.isActive ?? null,
    is_paused: fs.states?.isPaused ?? null,
    will_expire: fs.states?.willExpire ?? null,
    is_annual: fs.states?.isAnnual ?? null,
    family_supplement_cents: fs.plan?.familySupplementTotalInCents ?? fs.familySupplement?.monthlyCents ?? null,
    family_supplement_count: fs.plan?.familySupplementCount ?? fs.familySupplementCount ?? null,
    promo_code: pickStr(fs.promoCode?.code) ?? null,
    promo_source: pickStr(fs.promoCode?.source) ?? null,
    promo_applied_at: toIso(fs.promoCode?.appliedDate),
    promo_expires_at: toIso(fs.promoCode?.expiresAt),
    start_at: toIso(fs.dates?.startDate),
    end_at: toIso(fs.dates?.endDate),
    cancelled_at: toIso(fs.dates?.cancelledDate),
    resumed_at: toIso(fs.dates?.resumedDate),
    metadata: {
      source: 'migration_script',
      raw_states: fs.states ?? null,
    },
    created_at: toIso(fs.createdAt) ?? new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

async function main() {
  console.log(`\n=== Migration Firestore subscriptions → Supabase ===`);
  console.log(`Mode: ${DRY_RUN ? 'DRY-RUN (aucune ecriture)' : 'APPLY (ecriture reelle)'}\n`);

  initializeFirebase();
  const db = getFirestore();

  const clientsSnap = await db.collection('Clients').get();
  console.log(`Clients Firestore trouves: ${clientsSnap.size}`);

  let migrated = 0;
  let skippedNoSub = 0;
  let skippedNoSupabase = 0;
  let errors = 0;

  for (const clientDoc of clientsSnap.docs) {
    const firebaseUid = clientDoc.id;

    const subSnap = await db
      .collection('Clients')
      .doc(firebaseUid)
      .collection('subscription')
      .doc('current')
      .get();

    if (!subSnap.exists) {
      skippedNoSub++;
      continue;
    }

    const subData = subSnap.data() as Record<string, any>;

    const { data: supaClient } = await supabase
      .from('clients')
      .select('id')
      .eq('firebase_uid', firebaseUid)
      .maybeSingle();

    if (!supaClient?.id) {
      skippedNoSupabase++;
      console.warn(`  [SKIP] ${firebaseUid} — pas de client Supabase correspondant`);
      continue;
    }

    const row = mapFirestoreSubToSupabase(supaClient.id, subData);

    if (DRY_RUN) {
      console.log(`  [DRY] ${firebaseUid} → ${supaClient.id} | ${row.membership_type} | ${row.plan_type} | ${row.price_cents} cents | active=${row.is_active}`);
      migrated++;
      continue;
    }

    const { error: upsertError } = await supabase
      .from('subscriptions')
      .upsert(row, { onConflict: 'client_id' });

    if (upsertError) {
      console.error(`  [ERR] ${firebaseUid}: ${upsertError.message}`);
      errors++;
    } else {
      console.log(`  [OK] ${firebaseUid} → ${supaClient.id} | ${row.membership_type}`);
      migrated++;
    }
  }

  console.log(`\n=== Resultats ===`);
  console.log(`Migres: ${migrated}`);
  console.log(`Sans subscription: ${skippedNoSub}`);
  console.log(`Sans client Supabase: ${skippedNoSupabase}`);
  console.log(`Erreurs: ${errors}`);
  if (DRY_RUN) console.log(`\n→ Relancer avec --apply pour executer reellement.`);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
