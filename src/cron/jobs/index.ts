import { registerClientActivityJob } from './clientActivity.job.js';
import { registerAnalyticsSyncJob } from './analyticsSync.job.js';
import { registerPaymeMonthlySyncJob } from './paymeMonthlySync.job.js';
import { registerSeniorityJob } from './seniority.job.js';
import { registerPromoRevertJob } from './promoRevert.job.js';
import { registerQueueWorker } from './queueWorker.job.js';
import { registerRateLimitCleanupJob } from './rateLimitCleanup.job.js';

type JobEntry = { name: string; register: () => boolean };

const ALL_JOBS: JobEntry[] = [
  { name: 'seniority',           register: registerSeniorityJob },
  { name: 'payme-monthly-sync',  register: registerPaymeMonthlySyncJob },
  { name: 'activity',            register: registerClientActivityJob },
  { name: 'analytics-sync',      register: registerAnalyticsSyncJob },
  { name: 'promo-revert',        register: registerPromoRevertJob },
  { name: 'queue-worker',        register: registerQueueWorker },
  { name: 'rate-limit-cleanup',  register: registerRateLimitCleanupJob },
];

/**
 * Enregistre tous les jobs et retourne la liste des noms activés.
 */
export function registerAllJobs(): string[] {
  const enabled: string[] = [];

  for (const job of ALL_JOBS) {
    try {
      if (job.register()) {
        enabled.push(job.name);
      }
    } catch (e: any) {
      console.error(`[cron] Failed to register job ${job.name}:`, e?.message || e);
    }
  }

  return enabled;
}
