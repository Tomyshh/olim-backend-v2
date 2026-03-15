import { registerDailyJob } from '../scheduler.js';
import { runDailyClientActivityJob } from '../../services/clientActivity.service.js';

export function registerClientActivityJob(): boolean {
  return registerDailyJob({
    name: 'activity-job',
    enabledEnv: 'ACTIVITY_JOB_ENABLED',
    defaultHour: 3,
    defaultMinute: 0,
    intervalHours: 4,
    run: () => runDailyClientActivityJob(),
  });
}
