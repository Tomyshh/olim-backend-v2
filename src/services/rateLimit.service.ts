import { getRedisClientOptional } from '../config/redis.js';

type MemoryEntry = { count: number; resetAtMs: number };
const mem = new Map<string, MemoryEntry>();

// Lua script: atomic INCR + EXPIRE guarantee.
// Returns [count, ttl] — TTL is always ≥ 1 after execution.
const INCR_WITH_TTL_LUA = `
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('TTL', KEYS[1])
if ttl < 0 then
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1]))
  ttl = tonumber(ARGV[1])
end
return {count, ttl}
`;

function getRedisOpTimeoutMs(): number {
  const raw = process.env.RATE_LIMIT_REDIS_TIMEOUT_MS;
  const n = raw ? Number(raw) : NaN;
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
      const result = await withTimeout(
        redis.eval(INCR_WITH_TTL_LUA, { keys: [key], arguments: [String(windowSeconds)] }) as Promise<number[]>,
        timeoutMs,
        'rateLimit.redis.eval'
      );
      const [count, ttl] = result;
      const remaining = Math.max(0, limit - count);
      if (count > limit) {
        return { allowed: false, retryAfterSeconds: Math.max(1, ttl) };
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


