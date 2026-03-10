/**
 * promoRevert.service.ts
 *
 * Scheduler quotidien qui détecte les abonnements dont la promo a expiré
 * (revertAt <= maintenant) et remet le prix PayMe au prix de base.
 *
 * Architecture:
 * 1. Lors du subscribe avec un code promo + promo_duration > 0, un document est
 *    créé dans la collection "PromoReverts" avec status = "pending" et une date revertAt.
 * 2. Ce scheduler tourne chaque nuit et traite tous les documents "pending" dont
 *    revertAt est dépassé.
 * 3. Pour les mensuels: appelle paymeSetSubscriptionPrice pour restaurer le prix de base,
 *    puis met à jour le document subscription/current.
 * 4. Pour les annuels: marque simplement le revert comme complété (le prix plein sera
 *    appliqué lors du renouvellement).
 * 5. Un hook "lazy" dans getSubscriptionStatus sert de safety-net pour les cas non traités.
 *
 * Activation: PROMO_REVERT_JOB_ENABLED=true
 * Heure: PROMO_REVERT_JOB_HOUR (défaut 5), PROMO_REVERT_JOB_MINUTE (défaut 0)
 */

import { randomUUID } from 'node:crypto';
import { admin, getFirestore } from '../config/firebase.js';
import { paymeSetSubscriptionPrice } from './payme.service.js';
import { dualWriteSubscription, dualWriteToSupabase } from './dualWrite.service.js';
import { supabase } from './supabase.service.js';

// ---------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------

type TimestampLike = { toDate: () => Date };

function isTimestampLike(value: any): value is TimestampLike {
  return !!value && typeof value === 'object' && typeof value.toDate === 'function';
}

function toDateOrNull(value: any): Date | null {
  if (!value) return null;
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  if (isTimestampLike(value)) {
    try {
      const d = value.toDate();
      return d instanceof Date && Number.isFinite(d.getTime()) ? d : null;
    } catch {
      return null;
    }
  }
  if (typeof value === 'string' && value.trim()) {
    const d = new Date(value.trim());
    return Number.isFinite(d.getTime()) ? d : null;
  }
  if (typeof value === 'object') {
    const seconds = (value as any).seconds ?? (value as any)._seconds;
    if (typeof seconds === 'number' && Number.isFinite(seconds)) {
      const d = new Date(seconds * 1000);
      return Number.isFinite(d.getTime()) ? d : null;
    }
  }
  return null;
}

function pickString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function msUntilNextLocalTime(params: { hour: number; minute: number; second?: number }): number {
  const now = new Date();
  const second = params.second ?? 0;
  const next = new Date(now);
  next.setHours(params.hour, params.minute, second, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  return Math.max(0, next.getTime() - now.getTime());
}

function startOfTodayAtLocalTime(params: { hour: number; minute: number; second?: number }, now: Date = new Date()): Date {
  const second = params.second ?? 0;
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), params.hour, params.minute, second, 0);
}

// ---------------------------------------------------------------------------
// Job Lease (anti-concurrence multi-instances)
// ---------------------------------------------------------------------------

const JOB_ID = 'promoRevert';
const LEASE_MS = 10 * 60 * 1000; // 10 min

async function tryAcquireJobLease(runId: string): Promise<{ acquired: boolean; reason?: string }> {
  const db = getFirestore();
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + LEASE_MS);
  const jobRef = db.collection('Jobs').doc(JOB_ID);

  try {
    const acquired = await db.runTransaction(async (tx) => {
      const snap = await tx.get(jobRef);
      const data = (snap.data() || {}) as any;
      const running = data?.running === true;
      const leaseUntilDate = toDateOrNull(data?.leaseUntil);

      if (running && leaseUntilDate && leaseUntilDate.getTime() > now.getTime()) {
        return false;
      }

      tx.set(
        jobRef,
        {
          jobId: JOB_ID,
          running: true,
          runId,
          leaseUntil,
          startedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        },
        { merge: true }
      );
      return true;
    });

    return acquired ? { acquired: true } : { acquired: false, reason: 'already_running' };
  } catch (e: any) {
    return { acquired: false, reason: String(e?.message || e) };
  }
}

async function releaseJobLease(runId: string, stats: Record<string, any>): Promise<void> {
  const db = getFirestore();
  await db
    .collection('Jobs')
    .doc(JOB_ID)
    .set(
      {
        running: false,
        runId,
        lastSuccessAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        lastRunStats: stats
      },
      { merge: true }
    )
    .catch(() => {});
}

async function releaseJobLeaseOnError(runId: string, error: string): Promise<void> {
  const db = getFirestore();
  await db
    .collection('Jobs')
    .doc(JOB_ID)
    .set(
      {
        running: false,
        runId,
        lastErrorAt: admin.firestore.FieldValue.serverTimestamp(),
        lastError: error,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    )
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// Logique de réversion
// ---------------------------------------------------------------------------

interface PromoRevertDoc {
  uid: string;
  promoCode: string;
  promotionId: string;
  revertAt: Date;
  basePriceInCents: number;
  discountedPriceInCents: number;
  planType: 'monthly' | 'annual';
  membershipType: string;
  paymeSubId: string | null;
  status: 'pending' | 'completed' | 'failed' | 'skipped';
}

async function revertSinglePromo(docId: string, data: PromoRevertDoc): Promise<'completed' | 'failed' | 'skipped'> {
  const db = getFirestore();
  const promoRevertRef = db.collection('PromoReverts').doc(docId);
  const uid = data.uid;
  const basePriceInCents = data.basePriceInCents;

  try {
    // Mensuel avec PayMe subscription: mettre à jour le prix PayMe
    if (data.planType === 'monthly' && data.paymeSubId) {
      // Vérifier que le sub n'a pas déjà été revert (double sécurité)
      const subRef = db.collection('Clients').doc(uid).collection('subscription').doc('current');
      const subSnap = await subRef.get();
      if (!subSnap.exists) {
        console.warn(`[promo-revert] Subscription doc absent pour uid=${uid}, skip`);
        await promoRevertRef.set({ status: 'skipped', completedAt: admin.firestore.FieldValue.serverTimestamp(), skipReason: 'no_subscription_doc' }, { merge: true });
        dualWriteToSupabase('promo_reverts', { firestore_id: docId, status: 'skipped', skip_reason: 'no_subscription_doc', completed_at: new Date().toISOString() }, { onConflict: 'firestore_id' }).catch(() => {});
        return 'skipped';
      }

      const subData = (subSnap.data() || {}) as any;
      const promoData = subData?.pricing?.promo as any;
      const alreadyReverted = !!promoData?.revertedAt;

      if (alreadyReverted) {
        console.log(`[promo-revert] Déjà revert pour uid=${uid}, skip`);
        await promoRevertRef.set({ status: 'skipped', completedAt: admin.firestore.FieldValue.serverTimestamp(), skipReason: 'already_reverted' }, { merge: true });
        dualWriteToSupabase('promo_reverts', { firestore_id: docId, status: 'skipped', skip_reason: 'already_reverted', completed_at: new Date().toISOString() }, { onConflict: 'firestore_id' }).catch(() => {});
        return 'skipped';
      }

      // Appeler PayMe pour remettre le prix de base
      await paymeSetSubscriptionPrice({ subId: data.paymeSubId, priceInCents: Math.floor(basePriceInCents) });

      // Mettre à jour Firestore subscription/current
      // IMPORTANT: promoCode = null pour que le frontend masque la carte "Période promotionnelle"
      await subRef.set(
        {
          plan: { price: Math.floor(basePriceInCents) },
          pricing: {
            discountInCents: 0,
            chargedPriceInCents: Math.floor(basePriceInCents),
            pricingSource: 'promo_reverted',
            promo: { ...(promoData || {}), revertedAt: admin.firestore.FieldValue.serverTimestamp() }
          },
          promoCode: admin.firestore.FieldValue.delete(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        },
        { merge: true }
      );

      // Mettre à jour PromoReverts
      await promoRevertRef.set(
        { status: 'completed', completedAt: admin.firestore.FieldValue.serverTimestamp() },
        { merge: true }
      );
      dualWriteSubscription(uid, { plan: { price: Math.floor(basePriceInCents) }, promoCode: null }).catch(() => {});
      dualWriteToSupabase('promo_reverts', { firestore_id: docId, status: 'completed', completed_at: new Date().toISOString() }, { onConflict: 'firestore_id' }).catch(() => {});

      console.log(`[promo-revert] Revert OK: uid=${uid}, subId=${data.paymeSubId}, prix ${data.discountedPriceInCents} -> ${basePriceInCents}`);
      return 'completed';
    }

    // Annuel: pas de subscription PayMe à modifier, on marque comme complété
    // Le prix plein sera appliqué au prochain renouvellement
    if (data.planType === 'annual') {
      const subRef = db.collection('Clients').doc(uid).collection('subscription').doc('current');
      const subSnap = await subRef.get();
      const promoData = subSnap.exists ? ((subSnap.data() || {}) as any)?.pricing?.promo : null;

      // IMPORTANT: promoCode = delete pour que le frontend masque la carte "Période promotionnelle"
      await subRef.set(
        {
          pricing: {
            pricingSource: 'promo_reverted',
            promo: { ...(promoData || {}), revertedAt: admin.firestore.FieldValue.serverTimestamp(), note: 'annual_promo_period_ended' }
          },
          promoCode: admin.firestore.FieldValue.delete(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        },
        { merge: true }
      );

      await promoRevertRef.set(
        { status: 'completed', completedAt: admin.firestore.FieldValue.serverTimestamp() },
        { merge: true }
      );
      dualWriteSubscription(uid, { promoCode: null }).catch(() => {});
      dualWriteToSupabase('promo_reverts', { firestore_id: docId, status: 'completed', completed_at: new Date().toISOString() }, { onConflict: 'firestore_id' }).catch(() => {});

      console.log(`[promo-revert] Revert annuel marqué: uid=${uid}`);
      return 'completed';
    }

    // Fallback: pas de subId pour un mensuel, on ne peut pas modifier le prix
    console.warn(`[promo-revert] Pas de paymeSubId pour uid=${uid} (monthly), skip`);
    await promoRevertRef.set({ status: 'skipped', completedAt: admin.firestore.FieldValue.serverTimestamp(), skipReason: 'no_payme_sub_id' }, { merge: true });
    dualWriteToSupabase('promo_reverts', { firestore_id: docId, status: 'skipped', skip_reason: 'no_payme_sub_id', completed_at: new Date().toISOString() }, { onConflict: 'firestore_id' }).catch(() => {});
    return 'skipped';
  } catch (e: any) {
    const errorMsg = String(e?.message || e);
    console.error(`[promo-revert] Échec pour uid=${uid}:`, errorMsg);
    await promoRevertRef.set(
      { status: 'failed', lastError: errorMsg, lastErrorAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    ).catch(() => {});
    dualWriteToSupabase('promo_reverts', { firestore_id: docId, status: 'failed', last_error: errorMsg, last_error_at: new Date().toISOString() }, { onConflict: 'firestore_id' }).catch(() => {});
    return 'failed';
  }
}

// ---------------------------------------------------------------------------
// Job principal
// ---------------------------------------------------------------------------

async function runPromoRevertJob(): Promise<Record<string, any> | null> {
  const runId = randomUUID();
  const lease = await tryAcquireJobLease(runId);
  if (!lease.acquired) {
    return null;
  }

  const stats = { processed: 0, completed: 0, failed: 0, skipped: 0 };

  try {
    const db = getFirestore();
    const now = new Date();

    const { data: promoRows, error: promoError } = await supabase
      .from('promo_reverts')
      .select('*')
      .eq('status', 'pending')
      .lte('revert_at', now.toISOString())
      .limit(100);

    if (promoError) {
      console.error('[promo-revert] Supabase query error:', promoError.message);
      await releaseJobLeaseOnError(runId, promoError.message);
      throw new Error(promoError.message);
    }

    if (!promoRows || promoRows.length === 0) {
      console.log('[promo-revert] Aucun revert à traiter.');
      await releaseJobLease(runId, stats);
      return stats;
    }

    console.log(`[promo-revert] ${promoRows.length} revert(s) à traiter.`);

    for (const row of promoRows) {
      const docId = String(row.firestore_id || '');

      const revertAt = toDateOrNull(row.revert_at);
      if (!revertAt || !docId) {
        stats.skipped++;
        stats.processed++;
        continue;
      }

      const promoRevertData: PromoRevertDoc = {
        uid: pickString(row.client_firebase_uid),
        promoCode: pickString(row.promo_code),
        promotionId: pickString(row.promotion_id),
        revertAt,
        basePriceInCents: Number(row.base_price_cents) || 0,
        discountedPriceInCents: Number(row.discounted_price_cents) || 0,
        planType: row.plan_type === 'annual' ? 'annual' : 'monthly',
        membershipType: pickString(row.membership_type),
        paymeSubId: pickString(row.payme_sub_id) || null,
        status: 'pending'
      };

      if (!promoRevertData.uid || !promoRevertData.basePriceInCents) {
        stats.skipped++;
        stats.processed++;
        await db.collection('PromoReverts').doc(docId).set(
          { status: 'skipped', skipReason: 'invalid_data', completedAt: admin.firestore.FieldValue.serverTimestamp() },
          { merge: true }
        ).catch(() => {});
        dualWriteToSupabase('promo_reverts', { firestore_id: docId, status: 'skipped', skip_reason: 'invalid_data', completed_at: new Date().toISOString() }, { onConflict: 'firestore_id' }).catch(() => {});
        continue;
      }

      const result = await revertSinglePromo(docId, promoRevertData);
      stats[result]++;
      stats.processed++;
    }

    if (promoRows.length >= 100) {
      console.log('[promo-revert] Batch max atteint, les restants seront traités au prochain run.');
    }

    console.log('[promo-revert] Stats:', stats);
    await releaseJobLease(runId, stats);
    return stats;
  } catch (e: any) {
    console.error('[promo-revert] Erreur globale:', e?.message || e);
    await releaseJobLeaseOnError(runId, String(e?.message || e));
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

export function startPromoRevertScheduler(): void {
  if (process.env.PROMO_REVERT_JOB_ENABLED !== 'true') return;

  const hourRaw = Number(process.env.PROMO_REVERT_JOB_HOUR || 5);
  const minuteRaw = Number(process.env.PROMO_REVERT_JOB_MINUTE || 0);
  const hour = Number.isFinite(hourRaw) ? Math.min(23, Math.max(0, Math.trunc(hourRaw))) : 5;
  const minute = Number.isFinite(minuteRaw) ? Math.min(59, Math.max(0, Math.trunc(minuteRaw))) : 0;

  async function runAndReschedule(): Promise<void> {
    try {
      const res = await runPromoRevertJob();
      if (!res) {
        console.log('[promo-revert] skipped (already running / locked)');
      }
    } catch (e: any) {
      console.warn('[promo-revert] job failed', { error: String(e?.message || e) });
    } finally {
      const ms = msUntilNextLocalTime({ hour, minute, second: 0 });
      console.log('[promo-revert] next run scheduled', { inMs: ms });
      setTimeout(() => void runAndReschedule(), ms).unref();
    }
  }

  async function maybeCatchUp(): Promise<void> {
    const db = getFirestore();
    const now = new Date();
    const todayTarget = startOfTodayAtLocalTime({ hour, minute, second: 0 }, now);
    if (now.getTime() < todayTarget.getTime()) return;

    try {
      const snap = await db.collection('Jobs').doc(JOB_ID).get();
      const data = (snap.data() || {}) as any;
      const lastSuccessAt = toDateOrNull(data?.lastSuccessAt);
      if (lastSuccessAt && lastSuccessAt.getTime() >= todayTarget.getTime()) return;
    } catch {
      return;
    }

    console.log('[promo-revert] catch-up triggered (missed scheduled time)');
    setTimeout(
      () => void runPromoRevertJob().catch((e) => console.warn('[promo-revert] catch-up failed', { error: e?.message })),
      30_000
    ).unref();
  }

  const firstDelay = msUntilNextLocalTime({ hour, minute, second: 0 });
  console.log('[promo-revert] scheduler enabled', { hour, minute, firstDelayMs: firstDelay });
  void maybeCatchUp();
  setTimeout(() => void runAndReschedule(), firstDelay).unref();
}
