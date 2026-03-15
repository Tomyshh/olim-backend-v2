import { registerDailyJob } from '../scheduler.js';
import { runPromoRevertJob } from '../../services/promoRevert.service.js';

export function registerPromoRevertJob(): boolean {
  return registerDailyJob({
    name: 'promo-revert',
    enabledEnv: 'PROMO_REVERT_JOB_ENABLED',
    defaultHour: 5,
    defaultMinute: 0,
    intervalHours: 4,
    firestoreJobId: 'promoRevert',
    run: () => runPromoRevertJob(),
  });
}
