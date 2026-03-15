import { registerDailyJob } from '../scheduler.js';
import { runDailyAnalyticsSyncJob } from '../../services/analyticsSync.service.js';

export function registerAnalyticsSyncJob(): boolean {
  return registerDailyJob({
    name: 'analytics-sync',
    enabledEnv: 'ANALYTICS_SYNC_JOB_ENABLED',
    hourEnv: 'ANALYTICS_SYNC_JOB_HOUR',
    minuteEnv: 'ANALYTICS_SYNC_JOB_MINUTE',
    defaultHour: 4,
    defaultMinute: 0,
    intervalHoursEnv: 'ANALYTICS_SYNC_JOB_INTERVAL_HOURS',
    defaultIntervalHours: 0,
    firestoreJobId: 'analyticsSync',
    run: () => runDailyAnalyticsSyncJob(),
  });
}
