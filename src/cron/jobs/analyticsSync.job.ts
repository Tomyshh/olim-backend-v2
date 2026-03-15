import { registerDailyJob } from '../scheduler.js';
import { runDailyAnalyticsSyncJob } from '../../services/analyticsSync.service.js';

export function registerAnalyticsSyncJob(): boolean {
  return registerDailyJob({
    name: 'analytics-sync',
    enabledEnv: 'ANALYTICS_SYNC_JOB_ENABLED',
    defaultHour: 4,
    defaultMinute: 0,
    intervalHours: 4,
    firestoreJobId: 'analyticsSync',
    run: () => runDailyAnalyticsSyncJob(),
  });
}
