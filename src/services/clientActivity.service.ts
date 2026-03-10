import { randomUUID } from 'node:crypto';
import { admin, getFirestore } from '../config/firebase.js';
import { runWithConcurrencyLimit } from './concurrencyLimit.service.js';
import { dualWriteClient } from './dualWrite.service.js';

type ClientActivityStatus = 'inactive' | 'low' | 'medium' | 'high' | 'very_high';

export type ClientActivitySnapshot = {
  version: 1;
  score: number; // 0..100
  status: ClientActivityStatus;
  lastRequestAt: Date | null;
  daysSinceLastRequest: number | null;
  currentMonthRequests: number;
  monthly_average: number; // moyenne / jour sur le mois courant (jour-à-date)
  requests30d: number;
  requests90d: number;
  computedAt: FirebaseFirestore.FieldValue;
};

type JobRunResult = {
  runId: string;
  startedAt: Date;
  finishedAt: Date;
  clientsScanned: number;
  clientsUpdated: number;
  clientsFailed: number;
};

function toDateOrNull(value: any): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value?.toDate === 'function') {
    try {
      const d = value.toDate();
      return d instanceof Date && Number.isFinite(d.getTime()) ? d : null;
    } catch {
      return null;
    }
  }
  // parfois stocké comme millisecondes
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) {
    const d = new Date(n);
    return Number.isFinite(d.getTime()) ? d : null;
  }
  return null;
}

function clampInt(n: number, min: number, max: number): number {
  const x = Math.trunc(n);
  if (x < min) return min;
  if (x > max) return max;
  return x;
}

function daysBetween(now: Date, past: Date): number {
  const ms = now.getTime() - past.getTime();
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

function monthStartLocal(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
}

function computeActivity(params: { now: Date; lastRequestAt: Date | null; requests30d: number; requests90d: number }): Omit<
  ClientActivitySnapshot,
  'computedAt'
> {
  const { now, lastRequestAt } = params;

  const daysSince = lastRequestAt ? Math.max(0, daysBetween(now, lastRequestAt)) : null;
  const requests30d = Math.max(0, Math.trunc(params.requests30d || 0));
  const requests90d = Math.max(0, Math.trunc(params.requests90d || 0));

  // NOTE: le statut est basé sur le nombre de demandes sur le mois courant.
  // Ici on renvoie uniquement les métriques de base, et on calcule le statut/score
  // dans `finalizeActivityWithMonthlyStats` une fois `currentMonthRequests` connu.
  const score = 0;
  const status: ClientActivityStatus = 'inactive';

  return {
    version: 1,
    score,
    status,
    lastRequestAt,
    daysSinceLastRequest: daysSince,
    currentMonthRequests: 0,
    monthly_average: 0,
    requests30d,
    requests90d
  };
}

function finalizeActivityWithMonthlyStats(params: {
  base: Omit<ClientActivitySnapshot, 'computedAt'>;
  currentMonthRequests: number;
  now: Date;
}): Omit<ClientActivitySnapshot, 'computedAt'> {
  const currentMonthRequests = Math.max(0, Math.trunc(params.currentMonthRequests || 0));
  const dayOfMonth = Math.max(1, params.now.getDate());
  const monthly_average = Number((currentMonthRequests / dayOfMonth).toFixed(4));

  // Score: mapping simple 0..14+ req/mois -> 0..100
  const score = clampInt(Math.min(100, (currentMonthRequests / 14) * 100), 0, 100);

  // 5 statuts (demandes/mois):
  // - inactive: 0
  // - low: 1..4
  // - medium: 5..8 (donc >4 et <=8)
  // - high: 9..14 (donc >8 et <=14)
  // - very_high: 15+ (donc >14)
  let status: ClientActivityStatus = 'inactive';
  if (currentMonthRequests === 0) status = 'inactive';
  else if (currentMonthRequests <= 4) status = 'low';
  else if (currentMonthRequests <= 8) status = 'medium';
  else if (currentMonthRequests <= 14) status = 'high';
  else status = 'very_high';

  return {
    ...params.base,
    score,
    status,
    currentMonthRequests,
    monthly_average
  };
}

async function countQuery(q: FirebaseFirestore.Query): Promise<number> {
  const anyQ: any = q as any;
  if (typeof anyQ.count === 'function') {
    // Firestore Aggregate queries (pas de lecture de documents)
    const snap = await anyQ.count().get();
    const data = snap?.data?.() as any;
    const c = Number(data?.count || 0);
    return Number.isFinite(c) ? c : 0;
  }

  // Fallback (moins optimal): lecture des ids uniquement
  const snap = await q.select(admin.firestore.FieldPath.documentId()).get();
  return snap.size || 0;
}

export async function computeClientActivityForClient(params: {
  clientId: string;
  now?: Date;
}): Promise<{
  clientId: string;
  activity: Omit<ClientActivitySnapshot, 'computedAt'>;
}> {
  const db = getFirestore();
  const now = params.now ?? new Date();

  const clientId = String(params.clientId || '').trim();
  if (!clientId) throw new Error('clientId manquant.');

  const clientRef = db.collection('Clients').doc(clientId);
  const clientSnap = await clientRef.get();
  if (!clientSnap.exists) throw new Error(`Client introuvable: ${clientId}`);

  const requestsRef = clientRef.collection('Requests');
  const from30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const from90 = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  const fromMonth = monthStartLocal(now);

  const lastSnap = await requestsRef.orderBy('Request Date', 'desc').limit(1).get();
  const lastRequestAt = lastSnap.empty ? null : toDateOrNull(lastSnap.docs[0]?.get('Request Date'));

  const q30 = requestsRef.where('Request Date', '>=', from30);
  const q90 = requestsRef.where('Request Date', '>=', from90);
  const qMonth = requestsRef.where('Request Date', '>=', fromMonth);
  const [requests30d, requests90d, currentMonthRequests] = await Promise.all([
    countQuery(q30),
    countQuery(q90),
    countQuery(qMonth)
  ]);

  const base = computeActivity({ now, lastRequestAt, requests30d, requests90d });
  const activity = finalizeActivityWithMonthlyStats({ base, currentMonthRequests, now });
  return { clientId, activity };
}

export async function writeClientActivityForClient(params: {
  clientId: string;
  activity: Omit<ClientActivitySnapshot, 'computedAt'>;
}): Promise<void> {
  const db = getFirestore();
  const clientId = String(params.clientId || '').trim();
  if (!clientId) throw new Error('clientId manquant.');

  const clientRef = db.collection('Clients').doc(clientId);
  await clientRef.set(
    {
      activity: {
        ...params.activity,
        computedAt: admin.firestore.FieldValue.serverTimestamp()
      } satisfies ClientActivitySnapshot
    } as any,
    { merge: true }
  );
  dualWriteClient(clientId, { activity: params.activity }).catch(() => {});
}

async function tryAcquireJobLease(params: {
  jobRef: FirebaseFirestore.DocumentReference;
  runId: string;
  leaseMs: number;
}): Promise<{ acquired: boolean; reason?: string }> {
  const db = getFirestore();
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + params.leaseMs);

  try {
    const acquired = await db.runTransaction(async (tx) => {
      const snap = await tx.get(params.jobRef);
      const data = (snap.data() || {}) as any;
      const running = data?.running === true;
      const leaseUntilDate = toDateOrNull(data?.leaseUntil);

      if (running && leaseUntilDate && leaseUntilDate.getTime() > now.getTime()) {
        return false;
      }

      tx.set(
        params.jobRef,
        {
          jobId: params.jobRef.id,
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

export async function runDailyClientActivityJob(params?: {
  pageSize?: number;
  concurrency?: number;
  leaseMs?: number;
}): Promise<JobRunResult | null> {
  const db = getFirestore();
  const runId = randomUUID();
  const startedAt = new Date();

  const jobRef = db.collection('Jobs').doc('dailyClientActivity');
  const leaseMs = Number(params?.leaseMs ?? Number(process.env.ACTIVITY_JOB_LEASE_MS || 2 * 60 * 60 * 1000));
  const lease = Number.isFinite(leaseMs) && leaseMs > 0 ? leaseMs : 2 * 60 * 60 * 1000;

  const lock = await tryAcquireJobLease({ jobRef, runId, leaseMs: lease });
  if (!lock.acquired) {
    console.log('[activity-job] skipped (no lease)', { reason: lock.reason || 'unknown' });
    return null;
  }

  const pageSizeRaw = Number(params?.pageSize ?? Number(process.env.ACTIVITY_JOB_PAGE_SIZE || 200));
  const pageSize = Number.isFinite(pageSizeRaw) && pageSizeRaw > 0 && pageSizeRaw <= 1000 ? Math.trunc(pageSizeRaw) : 200;

  const concRaw = Number(params?.concurrency ?? Number(process.env.ACTIVITY_JOB_CONCURRENCY || 15));
  const concurrency = Number.isFinite(concRaw) && concRaw > 0 && concRaw <= 50 ? Math.trunc(concRaw) : 15;

  const writer = db.bulkWriter();
  writer.onWriteError((err) => {
    console.warn('[activity-job] write error (will retry?)', {
      path: err.documentRef?.path,
      code: (err as any)?.code,
      message: err.message,
      failedAttempts: err.failedAttempts
    });
    // retries prudents
    return err.failedAttempts < 3;
  });

  let clientsScanned = 0;
  let clientsUpdated = 0;
  let clientsFailed = 0;

  const now = new Date();

  let lastDoc: FirebaseFirestore.QueryDocumentSnapshot | null = null;

  try {
    while (true) {
      let q = db.collection('Clients').orderBy(admin.firestore.FieldPath.documentId()).limit(pageSize);
      if (lastDoc) q = q.startAfter(lastDoc);

      const snap = await q.get();
      if (snap.empty) break;
      lastDoc = snap.docs[snap.docs.length - 1]!;

      const tasks = snap.docs.map((clientDoc) =>
        runWithConcurrencyLimit({
          key: 'activity-job:per-client',
          limit: concurrency,
          waitTimeoutMs: 60_000,
          fn: async () => {
            clientsScanned += 1;
            const clientId = clientDoc.id;
            const clientRef = db.collection('Clients').doc(clientId);

            try {
              const computed = (await computeClientActivityForClient({ clientId, now })).activity;
              const patch = { activity: { ...computed, computedAt: admin.firestore.FieldValue.serverTimestamp() } satisfies ClientActivitySnapshot };

              writer.set(clientRef, patch as any, { merge: true });
              dualWriteClient(clientId, { activity: computed }).catch(() => {});
              clientsUpdated += 1;
            } catch (e: any) {
              clientsFailed += 1;
              console.warn('[activity-job] client failed (skipped)', {
                clientId,
                error: String(e?.message || e)
              });
            }
          }
        })
      );

      await Promise.all(tasks);
    }

    await writer.close();

    const finishedAt = new Date();
    await jobRef.set(
      {
        jobId: jobRef.id,
        running: false,
        runId,
        leaseUntil: new Date(finishedAt.getTime()), // garde une valeur non-nulle (pas de suppression de champ)
        lastSuccessAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        lastError: null,
        stats: {
          clientsScanned,
          clientsUpdated,
          clientsFailed,
          durationMs: finishedAt.getTime() - startedAt.getTime()
        }
      },
      { merge: true }
    );

    return { runId, startedAt, finishedAt, clientsScanned, clientsUpdated, clientsFailed };
  } catch (e: any) {
    const finishedAt = new Date();
    try {
      await writer.close();
    } catch {
      // ignore
    }

    await jobRef.set(
      {
        jobId: jobRef.id,
        running: false,
        runId,
        leaseUntil: new Date(finishedAt.getTime()),
        lastError: String(e?.message || e),
        lastFailedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        stats: {
          clientsScanned,
          clientsUpdated,
          clientsFailed,
          durationMs: finishedAt.getTime() - startedAt.getTime()
        }
      },
      { merge: true }
    );

    throw e;
  }
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

export function startDailyClientActivityScheduler(): void {
  if (process.env.ACTIVITY_JOB_ENABLED !== 'true') return;

  const hourRaw = Number(process.env.ACTIVITY_JOB_HOUR || 3);
  const minuteRaw = Number(process.env.ACTIVITY_JOB_MINUTE || 0);
  const hour = Number.isFinite(hourRaw) ? Math.min(23, Math.max(0, Math.trunc(hourRaw))) : 3;
  const minute = Number.isFinite(minuteRaw) ? Math.min(59, Math.max(0, Math.trunc(minuteRaw))) : 0;

  async function runAndReschedule(): Promise<void> {
    try {
      console.log('[activity-job] starting', { hour, minute });
      const res = await runDailyClientActivityJob();
      if (res) {
        console.log('[activity-job] done', {
          runId: res.runId,
          clientsScanned: res.clientsScanned,
          clientsUpdated: res.clientsUpdated,
          clientsFailed: res.clientsFailed,
          durationMs: res.finishedAt.getTime() - res.startedAt.getTime()
        });
      }
    } catch (e: any) {
      console.warn('[activity-job] failed', { error: String(e?.message || e) });
    } finally {
      const ms = msUntilNextLocalTime({ hour, minute, second: 0 });
      console.log('[activity-job] next run scheduled', { inMs: ms });
      setTimeout(() => void runAndReschedule(), ms).unref();
    }
  }

  const firstDelay = msUntilNextLocalTime({ hour, minute, second: 0 });
  console.log('[activity-job] scheduler enabled', { hour, minute, firstDelayMs: firstDelay });
  setTimeout(() => void runAndReschedule(), firstDelay).unref();
}


