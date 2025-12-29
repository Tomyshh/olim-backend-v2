import { getRedisClientOptional } from '../config/redis.js';

type MemoryEntry = { count: number; resetAtMs: number };
const mem = new Map<string, MemoryEntry>();

export async function consumeRateLimit(params: {
  key: string;
  limit: number;
  windowSeconds: number;
}): Promise<{ allowed: true; remaining: number } | { allowed: false; retryAfterSeconds: number }> {
  const { key, limit, windowSeconds } = params;
  const now = Date.now();

  const redis = await getRedisClientOptional();
  if (redis) {
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, windowSeconds);
    }
    const remaining = Math.max(0, limit - count);
    if (count > limit) {
      const ttl = await redis.ttl(key);
      return { allowed: false, retryAfterSeconds: Math.max(1, ttl > 0 ? ttl : windowSeconds) };
    }
    return { allowed: true, remaining };
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


