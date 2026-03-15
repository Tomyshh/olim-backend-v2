import { msUntilNextLocalTime } from '../scheduler.js';
import { runFullFirestoreSync } from '../../services/firestoreSync.service.js';

const HOUR = 2;
const MINUTE = 30;

export function registerFirestoreSyncJob(): boolean {
  async function runAndReschedule(): Promise<void> {
    try {
      console.log(`[firestore-sync] starting (${HOUR}:${String(MINUTE).padStart(2, '0')})`);
      await runFullFirestoreSync();
    } catch (e: any) {
      console.warn(`[firestore-sync] failed`, { error: String(e?.message || e) });
    } finally {
      const ms = msUntilNextLocalTime({ hour: HOUR, minute: MINUTE, second: 0 });
      console.log(`[firestore-sync] next run scheduled`, { inMs: ms });
      setTimeout(() => void runAndReschedule(), ms).unref();
    }
  }

  const firstDelay = msUntilNextLocalTime({ hour: HOUR, minute: MINUTE, second: 0 });
  console.log(`[firestore-sync] scheduler enabled`, { hour: HOUR, minute: MINUTE, firstDelayMs: firstDelay });
  setTimeout(() => void runAndReschedule(), firstDelay).unref();
  return true;
}
