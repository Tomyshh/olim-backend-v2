import { registerDailyJob } from '../scheduler.js';
import { runFullFirestoreSync } from '../../services/firestoreSync.service.js';

export function registerFirestoreSyncJob(): boolean {
  return registerDailyJob({
    name: 'firestore-sync',
    enabledEnv: 'FIRESTORE_SYNC_JOB_ENABLED',
    defaultHour: 2,
    defaultMinute: 30,
    hourEnv: 'FIRESTORE_SYNC_JOB_HOUR',
    minuteEnv: 'FIRESTORE_SYNC_JOB_MINUTE',
    intervalHours: 0,
    firestoreJobId: 'dailyFirestoreSync',
    catchUpDelayMs: 60_000,
    run: () => runFullFirestoreSync(),
  });
}
