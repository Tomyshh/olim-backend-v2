import { randomUUID } from 'node:crypto';
import { getRedisClientOptional } from '../config/redis.js';

export type JobStatus = 'queued' | 'processing' | 'completed' | 'failed';

export type JobRecord = {
  id: string;
  queue: string;
  type: string;
  status: JobStatus;
  payload: any;
  createdAt: string;
  updatedAt: string;
  error?: string;
};

function jobKey(id: string): string {
  return `job:${id}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

export async function enqueueJob(params: {
  queue: string;
  type: string;
  payload: any;
  ttlSeconds?: number;
}): Promise<{ jobId: string } | null> {
  const redis = await getRedisClientOptional();
  if (!redis) return null;

  const id = randomUUID();
  const rec: JobRecord = {
    id,
    queue: params.queue,
    type: params.type,
    status: 'queued',
    payload: params.payload,
    createdAt: nowIso(),
    updatedAt: nowIso()
  };

  const ttl = Number(params.ttlSeconds ?? Number(process.env.JOB_TTL_SECONDS || 24 * 3600));
  const ttlSeconds = Number.isFinite(ttl) && ttl > 0 ? ttl : 24 * 3600;

  // On persiste d’abord l’état, puis on push dans la queue (ordre important pour la lisibilité)
  await redis.set(jobKey(id), JSON.stringify(rec), { EX: ttlSeconds });
  await redis.lPush(params.queue, JSON.stringify({ id }));
  return { jobId: id };
}

export async function getJob(jobId: string): Promise<JobRecord | null> {
  const redis = await getRedisClientOptional();
  if (!redis) return null;
  const raw = await redis.get(jobKey(jobId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as JobRecord;
  } catch {
    return null;
  }
}

async function updateJob(jobId: string, patch: Partial<JobRecord>): Promise<void> {
  const redis = await getRedisClientOptional();
  if (!redis) return;
  const raw = await redis.get(jobKey(jobId));
  if (!raw) return;
  let current: JobRecord | null = null;
  try {
    current = JSON.parse(raw) as JobRecord;
  } catch {
    return;
  }
  const updated: JobRecord = { ...current, ...patch, updatedAt: nowIso() };
  // conserve le TTL existant (best-effort). Si ttl = -1 ou erreurs, on set sans EX.
  try {
    const ttl = await redis.ttl(jobKey(jobId));
    if (ttl && ttl > 0) {
      await redis.set(jobKey(jobId), JSON.stringify(updated), { EX: ttl });
      return;
    }
  } catch {
    // ignore
  }
  await redis.set(jobKey(jobId), JSON.stringify(updated));
}

export type JobHandler = (job: JobRecord) => Promise<void>;

export function startQueueWorker(params: {
  queues: string[];
  handlers: Record<string, JobHandler>;
  pollTimeoutSeconds?: number;
  enabledEnvVar?: string;
}): { stop: () => void } {
  const enabledVar = params.enabledEnvVar || 'QUEUE_WORKER_ENABLED';
  if (process.env[enabledVar] !== 'true') {
    return { stop: () => {} };
  }

  let stopped = false;

  const pollTimeoutSeconds = Number(params.pollTimeoutSeconds ?? Number(process.env.QUEUE_POLL_TIMEOUT_SECONDS || 5));
  const timeoutSeconds = Number.isFinite(pollTimeoutSeconds) && pollTimeoutSeconds > 0 ? pollTimeoutSeconds : 5;

  async function loop(): Promise<void> {
    while (!stopped) {
      const redis = await getRedisClientOptional();
      if (!redis) {
        // Redis pas dispo: on attend et on retente
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }

      try {
        // BRPOP: attend un job sur n’importe quelle queue
        const res = await redis.brPop(params.queues, timeoutSeconds);
        if (!res) continue;
        const raw = res.element;
        let id = '';
        try {
          id = String(JSON.parse(raw)?.id || '');
        } catch {
          id = '';
        }
        if (!id) continue;

        const job = await getJob(id);
        if (!job) continue;

        await updateJob(id, { status: 'processing' });
        const handler = params.handlers[job.type];
        if (!handler) {
          await updateJob(id, { status: 'failed', error: `No handler for type=${job.type}` });
          continue;
        }

        try {
          await handler(job);
          await updateJob(id, { status: 'completed' });
        } catch (e: any) {
          await updateJob(id, { status: 'failed', error: String(e?.message || e) });
        }
      } catch (e) {
        // boucle robuste: ne pas casser le process
        console.warn('Queue worker loop error (ignored):', e);
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }

  void loop();
  return { stop: () => (stopped = true) };
}


