import { registerDailyJob } from '../scheduler.js';
import { runDailyPaymeMonthlyNextPaymentDateSyncJob } from '../../services/paymeMonthlyNextPaymentSync.service.js';

export function registerPaymeMonthlySyncJob(): boolean {
  return registerDailyJob({
    name: 'payme-monthly-sync',
    enabledEnv: 'PAYME_MONTHLY_NEXT_PAYMENT_SYNC_ENABLED',
    defaultHour: 2,
    defaultMinute: 0,
    intervalHours: 4,
    firestoreJobId: 'paymeMonthlyNextPaymentSync',
    run: () => runDailyPaymeMonthlyNextPaymentDateSyncJob(),
  });
}
