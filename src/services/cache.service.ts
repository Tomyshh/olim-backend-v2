import { getRedisClientOptional } from '../config/redis.js';

export type CacheResult<T> = {
  value: T;
  cacheStatus: 'HIT' | 'WAIT_HIT' | 'MISS' | 'MISS_NOLOCK' | 'BYPASS';
};

export async function getJsonFromCache<T>(key: string): Promise<T | null> {
  const redis = await getRedisClientOptional();
  if (!redis) return null;
  const raw = await redis.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function setJsonInCache(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  const redis = await getRedisClientOptional();
  if (!redis) return;
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) return;
  await redis.set(key, JSON.stringify(value), { EX: ttlSeconds });
}

/**
 * Cache JSON avec anti-stampede via lock Redis.
 * - Si pas de Redis: calcule et renvoie BYPASS.
 * - Si lock non obtenu: attend brièvement un remplissage cache (WAIT_HIT), sinon calcule (MISS_NOLOCK).
 * - Si lock obtenu: calcule, met en cache, relâche le lock (MISS).
 */
export async function getOrSetJsonWithLock<T>(params: {
  key: string;
  ttlSeconds: number;
  lockTtlSeconds?: number;
  waitScheduleMs?: number[];
  fn: () => Promise<T>;
}): Promise<CacheResult<T>> {
  const redis = await getRedisClientOptional();
  if (!redis) {
    const value = await params.fn();
    return { value, cacheStatus: 'BYPASS' };
  }

  const cached = await getJsonFromCache<T>(params.key);
  if (cached !== null) return { value: cached, cacheStatus: 'HIT' };

  const lockKey = `lock:${params.key}`;
  const lockToken = `${Date.now()}:${Math.random().toString(16).slice(2)}`;
  const lockTtlSeconds = Number.isFinite(params.lockTtlSeconds) && (params.lockTtlSeconds as number) > 0 ? (params.lockTtlSeconds as number) : 15;
  const haveLock = (await redis.set(lockKey, lockToken, { NX: true, EX: lockTtlSeconds })) === 'OK';

  if (!haveLock) {
    for (const waitMs of params.waitScheduleMs || [200, 300, 500]) {
      await new Promise((r) => setTimeout(r, waitMs));
      const waited = await getJsonFromCache<T>(params.key);
      if (waited !== null) return { value: waited, cacheStatus: 'WAIT_HIT' };
    }
    const value = await params.fn();
    return { value, cacheStatus: 'MISS_NOLOCK' };
  }

  try {
    const value = await params.fn();
    await setJsonInCache(params.key, value, params.ttlSeconds);
    return { value, cacheStatus: 'MISS' };
  } finally {
    // Release lock best-effort si on est propriétaire
    try {
      const current = await redis.get(lockKey);
      if (current === lockToken) await redis.del(lockKey);
    } catch {
      // ignore
    }
  }
}


