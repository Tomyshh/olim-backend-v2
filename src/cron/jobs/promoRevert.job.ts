import { registerDailyJob } from '../scheduler.js';
import { runPromoRevertJob } from '../../services/promoRevert.service.js';

export function registerPromoRevertJob(): boolean {
  return registerDailyJob({
    name: 'promo-revert',
    enabledEnv: 'PROMO_REVERT_JOB_ENABLED',
    hourEnv: 'PROMO_REVERT_JOB_HOUR',
    minuteEnv: 'PROMO_REVERT_JOB_MINUTE',
    defaultHour: 5,
    defaultMinute: 0,
    intervalHoursEnv: 'PROMO_REVERT_JOB_INTERVAL_HOURS',
    defaultIntervalHours: 0,
    firestoreJobId: 'promoRevert',
    run: () => runPromoRevertJob(),
  });
}
