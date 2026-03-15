import { registerDailyJob } from '../scheduler.js';
import { runDailyClientActivityJob } from '../../services/clientActivity.service.js';

export function registerClientActivityJob(): boolean {
  return registerDailyJob({
    name: 'activity-job',
    enabledEnv: 'ACTIVITY_JOB_ENABLED',
    hourEnv: 'ACTIVITY_JOB_HOUR',
    minuteEnv: 'ACTIVITY_JOB_MINUTE',
    defaultHour: 3,
    defaultMinute: 0,
    intervalHoursEnv: 'ACTIVITY_JOB_INTERVAL_HOURS',
    defaultIntervalHours: 0,
    run: () => runDailyClientActivityJob(),
  });
}
