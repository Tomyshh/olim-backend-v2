import { registerDailyJob } from '../scheduler.js';
import { runDailySeniorityJob } from '../../services/clientSeniority.service.js';

export function registerSeniorityJob(): boolean {
  return registerDailyJob({
    name: 'seniority-job',
    enabledEnv: 'SENIORITY_JOB_ENABLED',
    hourEnv: 'SENIORITY_JOB_HOUR',
    minuteEnv: 'SENIORITY_JOB_MINUTE',
    defaultHour: 1,
    defaultMinute: 0,
    intervalHoursEnv: 'SENIORITY_JOB_INTERVAL_HOURS',
    defaultIntervalHours: 0,
    run: () => runDailySeniorityJob(),
  });
}
