import { registerDailyJob } from '../scheduler.js';
import { getRedisClientOptional } from '../../config/redis.js';

async function cleanupOrphanedRateLimitKeys(): Promise<void> {
  const redis = await getRedisClientOptional();
  if (!redis) return;

  let cursor = 0;
  let cleaned = 0;

  do {
    const result = await redis.scan(cursor, { MATCH: 'rl:*', COUNT: 200 });
    cursor = result.cursor;

    for (const key of result.keys) {
      const ttl = await redis.ttl(key);
      if (ttl < 0) {
        await redis.del(key);
        cleaned++;
      }
    }
  } while (cursor !== 0);

  if (cleaned > 0) {
    console.log(`[rate-limit-cleanup] purged ${cleaned} orphaned keys`);
  }
}

export function registerRateLimitCleanupJob(): boolean {
  return registerDailyJob({
    name: 'rate-limit-cleanup',
    enabledEnv: 'GLOBAL_RATE_LIMIT_ENABLED',
    defaultHour: 0,
    defaultMinute: 0,
    intervalHoursEnv: 'RATE_LIMIT_CLEANUP_INTERVAL_HOURS',
    intervalHours: 1,
    run: () => cleanupOrphanedRateLimitKeys(),
  });
}
