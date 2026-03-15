import { registerDailyJob } from '../scheduler.js';
import { runDailyPaymeMonthlyNextPaymentDateSyncJob } from '../../services/paymeMonthlyNextPaymentSync.service.js';

export function registerPaymeMonthlySyncJob(): boolean {
  return registerDailyJob({
    name: 'payme-monthly-sync',
    enabledEnv: 'PAYME_MONTHLY_NEXT_PAYMENT_SYNC_ENABLED',
    hourEnv: 'PAYME_MONTHLY_NEXT_PAYMENT_SYNC_HOUR',
    minuteEnv: 'PAYME_MONTHLY_NEXT_PAYMENT_SYNC_MINUTE',
    defaultHour: 2,
    defaultMinute: 0,
    intervalHoursEnv: 'PAYME_MONTHLY_NEXT_PAYMENT_SYNC_INTERVAL_HOURS',
    defaultIntervalHours: 0,
    firestoreJobId: 'paymeMonthlyNextPaymentSync',
    run: () => runDailyPaymeMonthlyNextPaymentDateSyncJob(),
  });
}
