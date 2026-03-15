import { randomUUID } from 'node:crypto';
import { admin, getFirestore } from '../config/firebase.js';
import { runWithConcurrencyLimit } from './concurrencyLimit.service.js';
import { dualWriteClient } from './dualWrite.service.js';
import { supabase } from './supabase.service.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SeniorityTier = 'ultra_new' | 'new' | 'bronze' | 'silver' | 'gold' | 'platinum';

export type ClientSenioritySnapshot = {
  version: 1;
  days: number;
  months: number;
  tier: SeniorityTier;
  tierLabel: string;
  since: Date | FirebaseFirestore.Timestamp | FirebaseFirestore.FieldValue;
  computedAt: FirebaseFirestore.FieldValue;
};

type JobRunResult = {
  runId: string;
  startedAt: Date;
  finishedAt: Date;
  clientsScanned: number;
  clientsUpdated: number;
  clientsSkipped: number;
  clientsFailed: number;
};

// ---------------------------------------------------------------------------
// Tier thresholds (jours)
// ---------------------------------------------------------------------------

const TIER_THRESHOLDS: readonly { maxDays: number; tier: SeniorityTier; label: string }[] = [
  { maxDays: 13, tier: 'ultra_new', label: 'Ultra-Nouveau' },
  { maxDays: 89, tier: 'new', label: 'Nouveau' },
  { maxDays: 179, tier: 'bronze', label: 'Bronze' },
  { maxDays: 364, tier: 'silver', label: 'Silver' },
  { maxDays: 729, tier: 'gold', label: 'Gold' },
  { maxDays: Infinity, tier: 'platinum', label: 'Platinum' }
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) {
    const d = new Date(n);
    return Number.isFinite(d.getTime()) ? d : null;
  }
  return null;
}

function daysBetween(now: Date, past: Date): number {
  const ms = now.getTime() - past.getTime();
  return Math.max(0, Math.floor(ms / (24 * 60 * 60 * 1000)));
}

function monthsBetween(now: Date, past: Date): number {
  const years = now.getFullYear() - past.getFullYear();
  const months = now.getMonth() - past.getMonth();
  let total = years * 12 + months;
  // Si le jour du mois courant est avant le jour de creation, on retire 1 mois
  if (now.getDate() < past.getDate()) total -= 1;
  return Math.max(0, total);
}

// ---------------------------------------------------------------------------
// Compute (fonction pure, exportee pour le backfill)
// ---------------------------------------------------------------------------

export function computeSeniority(createdAt: Date, now: Date): Omit<ClientSenioritySnapshot, 'since' | 'computedAt'> {
  const days = daysBetween(now, createdAt);
  const months = monthsBetween(now, createdAt);

  let tier: SeniorityTier = 'platinum';
  let tierLabel = 'Platinum';
  for (const t of TIER_THRESHOLDS) {
    if (days <= t.maxDays) {
      tier = t.tier;
      tierLabel = t.label;
      break;
    }
  }

  return { version: 1, days, months, tier, tierLabel };
}

/**
 * Construit l'objet seniority initial pour un client tout juste cree (days=0, tier=ultra_new).
 * Utilise serverTimestamp() pour `since` et `computedAt`.
 */
export function buildInitialSeniority(): Record<string, any> {
  return {
    version: 1,
    days: 0,
    months: 0,
    tier: 'ultra_new' as SeniorityTier,
    tierLabel: 'Ultra-Nouveau',
    since: admin.firestore.FieldValue.serverTimestamp(),
    computedAt: admin.firestore.FieldValue.serverTimestamp()
  };
}

// ---------------------------------------------------------------------------
// Per-client compute + write
// ---------------------------------------------------------------------------

export async function computeAndWriteSeniorityForClient(params: {
  clientId: string;
  now?: Date;
  commit?: boolean;
}): Promise<
  | { ok: true; clientId: string; action: 'updated' | 'dry_run'; seniority: ReturnType<typeof computeSeniority> }
  | { ok: false; clientId: string; reason: string }
> {
  const db = getFirestore();
  const now = params.now ?? new Date();
  const commit = params.commit !== false;
  const clientId = String(params.clientId || '').trim();
  if (!clientId) return { ok: false, clientId, reason: 'clientId manquant' };

  const { data: clientRow, error: clientError } = await supabase
    .from('clients')
    .select('id, created_at')
    .eq('firebase_uid', clientId)
    .single();
  if (clientError || !clientRow) return { ok: false, clientId, reason: 'client_not_found' };

  const createdAt = clientRow.created_at ? new Date(clientRow.created_at) : null;
  if (!createdAt || !Number.isFinite(createdAt.getTime())) return { ok: false, clientId, reason: 'no_created_at' };

  const seniority = computeSeniority(createdAt, now);

  if (!commit) {
    return { ok: true, clientId, action: 'dry_run', seniority };
  }

  const clientRef = db.collection('Clients').doc(clientId);
  const ts = admin.firestore.Timestamp.fromDate(createdAt);
  await clientRef.set(
    {
      seniority: {
        ...seniority,
        since: ts,
        computedAt: admin.firestore.FieldValue.serverTimestamp()
      }
    },
    { merge: true }
  );
  dualWriteClient(clientId, { seniority: { ...seniority, since: createdAt.toISOString() } }).catch((e: any) => console.error('[seniority-job] dualWriteClient failed:', clientId, e?.message || e));

  return { ok: true, clientId, action: 'updated', seniority };
}

// ---------------------------------------------------------------------------
// Lease (meme pattern que clientActivity)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Daily job (parcours pagine + bulkWriter)
// ---------------------------------------------------------------------------

export async function runDailySeniorityJob(params?: {
  pageSize?: number;
  concurrency?: number;
  leaseMs?: number;
}): Promise<JobRunResult | null> {
  const db = getFirestore();
  const runId = randomUUID();
  const startedAt = new Date();

  const jobRef = db.collection('Jobs').doc('dailySeniority');
  const leaseMs = Number(params?.leaseMs ?? Number(process.env.SENIORITY_JOB_LEASE_MS || 2 * 60 * 60 * 1000));
  const lease = Number.isFinite(leaseMs) && leaseMs > 0 ? leaseMs : 2 * 60 * 60 * 1000;

  const lock = await tryAcquireJobLease({ jobRef, runId, leaseMs: lease });
  if (!lock.acquired) {
    console.log('[seniority-job] skipped (no lease)', { reason: lock.reason || 'unknown' });
    return null;
  }

  const pageSizeRaw = Number(params?.pageSize ?? Number(process.env.SENIORITY_JOB_PAGE_SIZE || 200));
  const pageSize = Number.isFinite(pageSizeRaw) && pageSizeRaw > 0 && pageSizeRaw <= 1000 ? Math.trunc(pageSizeRaw) : 200;

  const concRaw = Number(params?.concurrency ?? Number(process.env.SENIORITY_JOB_CONCURRENCY || 15));
  const concurrency = Number.isFinite(concRaw) && concRaw > 0 && concRaw <= 50 ? Math.trunc(concRaw) : 15;

  const writer = db.bulkWriter();
  writer.onWriteError((err) => {
    console.warn('[seniority-job] write error (will retry?)', {
      path: err.documentRef?.path,
      code: (err as any)?.code,
      message: err.message,
      failedAttempts: err.failedAttempts
    });
    return err.failedAttempts < 3;
  });

  let clientsScanned = 0;
  let clientsUpdated = 0;
  let clientsSkipped = 0;
  let clientsFailed = 0;

  const now = new Date();

  let lastDoc: FirebaseFirestore.QueryDocumentSnapshot | null = null;

  try {
    while (true) {
      // On lit uniquement les champs necessaires pour limiter le payload
      let q = db
        .collection('Clients')
        .select('Created At', 'createdAt')
        .orderBy(admin.firestore.FieldPath.documentId())
        .limit(pageSize);
      if (lastDoc) q = q.startAfter(lastDoc);

      const snap = await q.get();
      if (snap.empty) break;
      lastDoc = snap.docs[snap.docs.length - 1]!;

      const tasks = snap.docs.map((clientDoc) =>
        runWithConcurrencyLimit({
          key: 'seniority-job:per-client',
          limit: concurrency,
          waitTimeoutMs: 60_000,
          fn: async () => {
            clientsScanned += 1;
            const clientId = clientDoc.id;
            const data = (clientDoc.data() || {}) as Record<string, any>;

            try {
              const createdAtRaw = data['Created At'] ?? data.createdAt;
              const createdAt = toDateOrNull(createdAtRaw);
              if (!createdAt) {
                clientsSkipped += 1;
                return;
              }

              const seniority = computeSeniority(createdAt, now);
              const ts = admin.firestore.Timestamp.fromDate(createdAt);

              const clientRef = db.collection('Clients').doc(clientId);
              writer.set(
                clientRef,
                {
                  seniority: {
                    ...seniority,
                    since: ts,
                    computedAt: admin.firestore.FieldValue.serverTimestamp()
                  }
                } as any,
                { merge: true }
              );
              dualWriteClient(clientId, { seniority: { ...seniority, since: createdAt.toISOString() } }).catch((e: any) => console.error('[seniority-job] dualWriteClient failed:', clientId, e?.message || e));
              clientsUpdated += 1;
            } catch (e: any) {
              clientsFailed += 1;
              console.warn('[seniority-job] client failed (skipped)', {
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
        leaseUntil: new Date(finishedAt.getTime()),
        lastSuccessAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        lastError: null,
        stats: {
          clientsScanned,
          clientsUpdated,
          clientsSkipped,
          clientsFailed,
          durationMs: finishedAt.getTime() - startedAt.getTime()
        }
      },
      { merge: true }
    );

    return { runId, startedAt, finishedAt, clientsScanned, clientsUpdated, clientsSkipped, clientsFailed };
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
          clientsSkipped,
          clientsFailed,
          durationMs: finishedAt.getTime() - startedAt.getTime()
        }
      },
      { merge: true }
    );

    throw e;
  }
}

