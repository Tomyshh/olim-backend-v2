import { getRedisClientOptional } from '../config/redis.js';

type MemoryEntry = { count: number; resetAtMs: number };
const mem = new Map<string, MemoryEntry>();

function getRedisOpTimeoutMs(): number {
  const raw = process.env.RATE_LIMIT_REDIS_TIMEOUT_MS;
  const n = raw ? Number(raw) : NaN;
  // Valeur conservatrice: on préfère fallback mémoire plutôt que bloquer le handler.
  return Number.isFinite(n) && n > 0 ? n : 250;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return p;
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label}: timeout after ${ms}ms`)), ms);
    (t as any).unref?.();
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

export async function consumeRateLimit(params: {
  key: string;
  limit: number;
  windowSeconds: number;
}): Promise<{ allowed: true; remaining: number } | { allowed: false; retryAfterSeconds: number }> {
  const { key, limit, windowSeconds } = params;
  const now = Date.now();

  const timeoutMs = getRedisOpTimeoutMs();
  let redis = null as Awaited<ReturnType<typeof getRedisClientOptional>>;
  try {
    redis = await withTimeout(getRedisClientOptional(), timeoutMs, 'rateLimit.redis.connect');
  } catch {
    redis = null;
  }
  if (redis) {
    try {
      const count = await withTimeout(redis.incr(key), timeoutMs, 'rateLimit.redis.incr');
      // Always ensure a TTL is set to prevent keys from living forever
      // if the initial expire() call failed or timed out.
      const currentTtl = await withTimeout(redis.ttl(key), timeoutMs, 'rateLimit.redis.ttl');
      if (currentTtl < 0) {
        await withTimeout(redis.expire(key, windowSeconds), timeoutMs, 'rateLimit.redis.expire');
      }
      const remaining = Math.max(0, limit - count);
      if (count > limit) {
        return { allowed: false, retryAfterSeconds: Math.max(1, currentTtl > 0 ? currentTtl : windowSeconds) };
      }
      return { allowed: true, remaining };
    } catch {
      redis = null;
    }
  }

  const existing = mem.get(key);
  if (!existing || now >= existing.resetAtMs) {
    const resetAtMs = now + windowSeconds * 1000;
    mem.set(key, { count: 1, resetAtMs });
    return { allowed: true, remaining: limit - 1 };
  }

  existing.count += 1;
  mem.set(key, existing);
  const remaining = Math.max(0, limit - existing.count);
  if (existing.count > limit) {
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAtMs - now) / 1000)) };
  }
  return { allowed: true, remaining };
}


