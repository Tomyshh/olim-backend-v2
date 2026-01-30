import { randomUUID } from 'node:crypto';
import { admin, getFirestore } from '../config/firebase.js';
import { paymeListSubscriptions, type PaymeSubscriptionListItem } from './payme.service.js';

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
  // Support {seconds,_seconds} JSON-like
  if (typeof value === 'object') {
    const seconds = (value as any).seconds ?? (value as any)._seconds;
    if (typeof seconds === 'number' && Number.isFinite(seconds)) {
      const d = new Date(seconds * 1000);
      return Number.isFinite(d.getTime()) ? d : null;
    }
  }
  return null;
}

function coerceSubCode(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string' && value.trim()) return value.trim();
  return '';
}

function addMonths(date: Date, months: number): Date {
  const d = new Date(date);
  const day = d.getDate();
  d.setMonth(d.getMonth() + months);
  // Ajustement fin de mois (ex: 31 + 1 mois)
  if (d.getDate() < day) d.setDate(0);
  return d;
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

async function tryAcquireJobLease(params: {
  jobId: string;
  runId: string;
  leaseMs: number;
}): Promise<{ acquired: boolean; reason?: string }> {
  const db = getFirestore();
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + params.leaseMs);
  const jobRef = db.collection('Jobs').doc(params.jobId);

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
          jobId: params.jobId,
          running: true,
          runId: params.runId,
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

function scorePaymeItem(it: PaymeSubscriptionListItem): number {
  const next = it?.nextPaymentDate instanceof Date ? it.nextPaymentDate.getTime() : 0;
  const last = it?.lastPaymentDate instanceof Date ? it.lastPaymentDate.getTime() : 0;
  // Priorité: nextPaymentDate, sinon lastPaymentDate
  return Math.max(next, last);
}

function pickBestBySubCode(items: PaymeSubscriptionListItem[]): Map<string, PaymeSubscriptionListItem> {
  const map = new Map<string, PaymeSubscriptionListItem>();
  for (const it of items) {
    const key = it?.subCode == null ? '' : String(it.subCode).trim();
    if (!key) continue;
    const prev = map.get(key);
    if (!prev) {
      map.set(key, it);
      continue;
    }
    if (scorePaymeItem(it) >= scorePaymeItem(prev)) {
      map.set(key, it);
    }
  }
  return map;
}

function extractMonthlySubCodeFromSubscriptionCurrent(sub: Record<string, any> | null): string {
  if (!sub) return '';
  const candidates = [
    sub?.payme?.subCode,
    (sub as any)?.subCode,
    (sub as any)?.sub_payme_code,
    (sub as any)?.payme?.sub_payme_code
  ];
  for (const c of candidates) {
    const v = coerceSubCode(c);
    if (v) return v;
  }
  return '';
}

export async function runDailyPaymeMonthlyNextPaymentDateSyncJob(params?: {
  leaseMs?: number;
  dryRun?: boolean;
  limitClients?: number; // debug / sécurité
  clientId?: string; // ciblage (debug / run ponctuel)
}): Promise<
  | {
      runId: string;
      startedAt: Date;
      finishedAt: Date;
      stats: {
        paymeItems: number;
        clientsScanned: number;
        monthlyDocsFound: number;
        updated: number;
        skippedNoSubDoc: number;
        skippedNotMonthly: number;
        skippedNoSubCode: number;
        skippedNoPaymeData: number;
        skippedNoDates: number;
        errors: number;
      };
    }
  | null
> {
  const db = getFirestore();
  const runId = randomUUID();
  const startedAt = new Date();

  const leaseMs = Number(params?.leaseMs ?? Number(process.env.PAYME_MONTHLY_NEXT_PAYMENT_SYNC_LEASE_MS || 2 * 60 * 60 * 1000));
  const lease = Number.isFinite(leaseMs) && leaseMs > 0 ? leaseMs : 2 * 60 * 60 * 1000;
  const dryRun = params?.dryRun ?? process.env.PAYME_MONTHLY_NEXT_PAYMENT_SYNC_DRY_RUN === 'true';
  const clientIdTarget = (params?.clientId ?? process.env.PAYME_MONTHLY_NEXT_PAYMENT_SYNC_CLIENT_ID ?? '').trim();

  const lock = await tryAcquireJobLease({ jobId: 'paymeMonthlyNextPaymentSync', runId, leaseMs: lease });
  if (!lock.acquired) {
    console.log('[payme-monthly-sync] skipped (no lease)', { reason: lock.reason || 'unknown' });
    return null;
  }

  const jobRef = db.collection('Jobs').doc('paymeMonthlyNextPaymentSync');

  const stats = {
    paymeItems: 0,
    clientsScanned: 0,
    monthlyDocsFound: 0,
    updated: 0,
    skippedNoSubDoc: 0,
    skippedNotMonthly: 0,
    skippedNoSubCode: 0,
    skippedNoPaymeData: 0,
    skippedNoDates: 0,
    errors: 0
  };

  try {
    console.log('[payme-monthly-sync] starting', { runId, dryRun });

    // 1) Charger PayMe une seule fois (plus efficace que N appels get-subscriptions)
    const paymeItems = await paymeListSubscriptions();
    stats.paymeItems = paymeItems.length;
    const bySubCode = pickBestBySubCode(paymeItems);

    // 2) Parcourir les clients (paginé) et ne traiter que subscription/current.plan.type === "monthly"
    const pageSize = 250;
    const docIdField = admin.firestore.FieldPath.documentId();
    let lastDoc: FirebaseFirestore.QueryDocumentSnapshot | null = null;
    let batch = db.batch();
    let writes = 0;

    async function commitBatchIfNeeded(force: boolean = false): Promise<void> {
      if (!force && writes < 400) return;
      if (writes === 0) return;
      if (dryRun) {
        // Reset batch counters only
        batch = db.batch();
        writes = 0;
        return;
      }
      await batch.commit();
      batch = db.batch();
      writes = 0;
    }

    const now = new Date();

    async function processOneClient(clientId: string): Promise<void> {
      const clientRef = db.collection('Clients').doc(clientId);
      const subRef = clientRef.collection('subscription').doc('current');
      const subSnap = await subRef.get();
      if (!subSnap.exists) {
        stats.skippedNoSubDoc++;
        return;
      }

      const sub = (subSnap.data() || {}) as Record<string, any>;
      stats.monthlyDocsFound++;

      const planType = typeof sub?.plan?.type === 'string' ? String(sub.plan.type).trim().toLowerCase() : '';
      if (planType !== 'monthly') {
        stats.skippedNotMonthly++;
        return;
      }

      const subCode = extractMonthlySubCodeFromSubscriptionCurrent(sub);
      if (!subCode) {
        stats.skippedNoSubCode++;
        return;
      }

      const payme = bySubCode.get(subCode) || null;
      if (!payme) {
        stats.skippedNoPaymeData++;
        return;
      }

      const desiredNext = payme.nextPaymentDate || null;
      const storedPlanNext = toDateOrNull(sub?.plan?.nextPaymentDate);
      const storedPaymeNext = toDateOrNull(sub?.payme?.nextPaymentDate);
      const storedPaymentNext = toDateOrNull(sub?.payment?.nextPaymentDate);
      const storedEnd = toDateOrNull(sub?.dates?.endDate);

      const patch: Record<string, any> = {
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      };

      let needsWrite = false;

      if (desiredNext) {
        const desiredMs = desiredNext.getTime();
        const alreadyOk =
          (storedPlanNext?.getTime?.() === desiredMs || storedPlanNext == null) &&
          (storedPaymeNext?.getTime?.() === desiredMs || storedPaymeNext == null) &&
          (storedPaymentNext?.getTime?.() === desiredMs || storedPaymentNext == null) &&
          (storedEnd?.getTime?.() === desiredMs || storedEnd == null);

        patch.plan = { ...(sub.plan || {}), nextPaymentDate: desiredNext };
        patch.payment = { ...(sub.payment || {}), nextPaymentDate: desiredNext };
        patch.payme = {
          ...(sub.payme || {}),
          nextPaymentDate: desiredNext,
          ...(payme.subStatus != null ? { sub_status: payme.subStatus } : {})
        };
        patch.dates = { ...(sub.dates || {}), endDate: desiredNext };

        const stillActive = now.getTime() < desiredMs;
        if (payme.subStatus === 5) {
          patch.states = { ...(sub.states || {}), isActive: stillActive, willExpire: stillActive };
        } else {
          patch.states = { ...(sub.states || {}), isActive: stillActive };
        }

        const mustBackfillPlanNext = storedPlanNext == null;
        const mustBackfillPaymeNext = storedPaymeNext == null;
        const mustBackfillPaymentNext = storedPaymentNext == null;
        const mustBackfillEnd = storedEnd == null;
        if (!alreadyOk || mustBackfillPlanNext || mustBackfillPaymeNext || mustBackfillPaymentNext || mustBackfillEnd) {
          needsWrite = true;
        }
      } else {
        const last = payme.lastPaymentDate || toDateOrNull(sub?.payment?.lastPaymentDate) || null;
        if (!last) {
          stats.skippedNoDates++;
          return;
        }
        const computedEnd = addMonths(last, 1);
        const desiredMs = computedEnd.getTime();
        const storedMs = storedEnd?.getTime?.() ?? null;
        if (storedMs !== desiredMs) {
          patch.dates = { ...(sub.dates || {}), endDate: computedEnd };
          needsWrite = true;
        }
      }

      if (!needsWrite) return;

      stats.updated++;
      if (!dryRun) {
        batch.set(subRef, patch, { merge: true });
        writes++;
        await commitBatchIfNeeded(false);
      } else {
        console.log('[payme-monthly-sync][DRY-RUN] would update', {
          clientId,
          subCode,
          desiredNext: desiredNext ? desiredNext.toISOString() : null,
          desiredEnd: desiredNext
            ? desiredNext.toISOString()
            : patch?.dates?.endDate
              ? toDateOrNull(patch.dates.endDate)?.toISOString?.() ?? null
              : null
        });
      }
    }

    if (clientIdTarget) {
      stats.clientsScanned = 1;
      await processOneClient(clientIdTarget);
    } else {
      while (true) {
        let q: FirebaseFirestore.Query = db.collection('Clients').orderBy(docIdField).limit(pageSize);
        if (lastDoc) q = q.startAfter(lastDoc);
        const snap = await q.get();
        if (snap.empty) break;
        lastDoc = snap.docs[snap.docs.length - 1]!;

        for (const clientDoc of snap.docs) {
          stats.clientsScanned++;
          if (params?.limitClients && stats.clientsScanned > params.limitClients) break;

          try {
            await processOneClient(clientDoc.id);
          } catch (e: any) {
            stats.errors++;
            console.warn('[payme-monthly-sync] client failed', {
              clientId: clientDoc.id,
              error: String(e?.message || e)
            });
          }
        }

        if (params?.limitClients && stats.clientsScanned >= params.limitClients) break;
      }
    }

    await commitBatchIfNeeded(true);

    const finishedAt = new Date();
    await jobRef.set(
      {
        jobId: jobRef.id,
        running: false,
        runId,
        leaseUntil: new Date(finishedAt.getTime()),
        lastSuccessAt: admin.firestore.FieldValue.serverTimestamp(),
        lastError: null,
        stats: {
          ...stats,
          dryRun,
          durationMs: finishedAt.getTime() - startedAt.getTime()
        },
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );

    console.log('[payme-monthly-sync] done', { runId, ...stats, dryRun, durationMs: finishedAt.getTime() - startedAt.getTime() });
    return { runId, startedAt, finishedAt, stats };
  } catch (e: any) {
    const finishedAt = new Date();
    await jobRef.set(
      {
        jobId: jobRef.id,
        running: false,
        runId,
        leaseUntil: new Date(finishedAt.getTime()),
        lastFailedAt: admin.firestore.FieldValue.serverTimestamp(),
        lastError: String(e?.message || e),
        stats: {
          ...stats,
          durationMs: finishedAt.getTime() - startedAt.getTime()
        },
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );
    throw e;
  }
}

export function startPaymeMonthlyNextPaymentDateSyncScheduler(): void {
  if (process.env.PAYME_MONTHLY_NEXT_PAYMENT_SYNC_ENABLED !== 'true') return;

  const hourRaw = Number(process.env.PAYME_MONTHLY_NEXT_PAYMENT_SYNC_HOUR || 2);
  const minuteRaw = Number(process.env.PAYME_MONTHLY_NEXT_PAYMENT_SYNC_MINUTE || 0);
  const hour = Number.isFinite(hourRaw) ? Math.min(23, Math.max(0, Math.trunc(hourRaw))) : 2;
  const minute = Number.isFinite(minuteRaw) ? Math.min(59, Math.max(0, Math.trunc(minuteRaw))) : 0;

  async function runAndReschedule(): Promise<void> {
    try {
      const res = await runDailyPaymeMonthlyNextPaymentDateSyncJob();
      if (!res) {
        console.log('[payme-monthly-sync] skipped (already running / locked)');
      }
    } catch (e: any) {
      console.warn('[payme-monthly-sync] job failed', { error: String(e?.message || e) });
    } finally {
      const ms = msUntilNextLocalTime({ hour, minute, second: 0 });
      console.log('[payme-monthly-sync] next run scheduled', { inMs: ms });
      setTimeout(() => void runAndReschedule(), ms).unref();
    }
  }

  async function maybeCatchUp(): Promise<void> {
    // Si le process démarre APRÈS l'heure cible et que le job n'a pas réussi aujourd'hui, on lance un rattrapage.
    const db = getFirestore();
    const now = new Date();
    const todayTarget = startOfTodayAtLocalTime({ hour, minute, second: 0 }, now);
    if (now.getTime() < todayTarget.getTime()) return;

    try {
      const snap = await db.collection('Jobs').doc('paymeMonthlyNextPaymentSync').get();
      const data = (snap.data() || {}) as any;
      const lastSuccessAt = toDateOrNull(data?.lastSuccessAt);
      if (lastSuccessAt && lastSuccessAt.getTime() >= todayTarget.getTime()) return;
    } catch {
      return;
    }

    console.log('[payme-monthly-sync] catch-up triggered (missed scheduled time)');
    setTimeout(
      () => void runDailyPaymeMonthlyNextPaymentDateSyncJob().catch((e) => console.warn('[payme-monthly-sync] catch-up failed', { error: e?.message })),
      30_000
    ).unref();
  }

  const firstDelay = msUntilNextLocalTime({ hour, minute, second: 0 });
  console.log('[payme-monthly-sync] scheduler enabled', { hour, minute, firstDelayMs: firstDelay });
  void maybeCatchUp();
  setTimeout(() => void runAndReschedule(), firstDelay).unref();
}

