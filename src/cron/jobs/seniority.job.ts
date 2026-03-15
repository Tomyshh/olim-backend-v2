import { registerDailyJob } from '../scheduler.js';
import { runDailySeniorityJob } from '../../services/clientSeniority.service.js';

export function registerSeniorityJob(): boolean {
  return registerDailyJob({
    name: 'seniority-job',
    enabledEnv: 'SENIORITY_JOB_ENABLED',
    defaultHour: 1,
    defaultMinute: 0,
    intervalHours: 4,
    run: () => runDailySeniorityJob(),
  });
}
