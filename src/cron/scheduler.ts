import { getFirestore } from '../config/firebase.js';

function toDateOrNull(value: any): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value?.toDate === 'function') {
    try {
      const d = value.toDate();
      return d instanceof Date && Number.isFinite(d.getTime()) ? d : null;
    } catch {
      return null;
    }
  }
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) {
    const d = new Date(n);
    return Number.isFinite(d.getTime()) ? d : null;
  }
  return null;
}

export function msUntilNextLocalTime(params: {
  hour: number;
  minute: number;
  second?: number;
}): number {
  const now = new Date();
  const second = params.second ?? 0;
  const next = new Date(now);
  next.setHours(params.hour, params.minute, second, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  return Math.max(0, next.getTime() - now.getTime());
}

function startOfTodayAtLocalTime(
  params: { hour: number; minute: number; second?: number },
  now: Date = new Date()
): Date {
  const second = params.second ?? 0;
  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    params.hour,
    params.minute,
    second,
    0
  );
}

function parseIntEnv(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  const n = Number(raw || fallback);
  return Number.isFinite(n)
    ? Math.min(max, Math.max(min, Math.trunc(n)))
    : fallback;
}

export type DailyJobConfig = {
  name: string;
  enabledEnv: string;
  /** Heure (0-23). Utilisé uniquement si intervalHours === 0. Optionnel : si hourEnv fourni, la valeur peut être surchargée par l'env. */
  defaultHour: number;
  defaultMinute: number;
  /** Noms des variables d'env pour surcharger heure/minute (optionnel). Si omis, seuls defaultHour/defaultMinute sont utilisés. */
  hourEnv?: string;
  minuteEnv?: string;
  /** Intervalle en heures (ex: 4 = toutes les 4 h). 0 = une fois par jour à defaultHour:defaultMinute. Ignoré si intervalHoursEnv est fourni. */
  intervalHours?: number;
  /** Variable d'env pour surcharger l'intervalle en heures (optionnel). Ex: 'RATE_LIMIT_CLEANUP_INTERVAL_HOURS'. Valeur par défaut = intervalHours. */
  intervalHoursEnv?: string;
  /** Firestore Jobs/<id> — si fourni, active le rattrapage (catch-up) au démarrage (mode quotidien uniquement) */
  firestoreJobId?: string;
  catchUpDelayMs?: number;
  run: () => Promise<unknown>;
};

/**
 * Enregistre un job quotidien planifié par setTimeout + .unref().
 * Pattern identique à l'ancien code (msUntilNextLocalTime → runAndReschedule)
 * avec support optionnel de catch-up via Firestore lease.
 *
 * Retourne `true` si le job a été activé, `false` sinon.
 */
export function registerDailyJob(config: DailyJobConfig): boolean {
  if (process.env[config.enabledEnv] !== 'true') {
    console.log(`[${config.name}] disabled (${config.enabledEnv} !== 'true')`);
    return false;
  }

  const hour = config.hourEnv
    ? parseIntEnv(process.env[config.hourEnv], config.defaultHour, 0, 23)
    : config.defaultHour;
  const minute = config.minuteEnv
    ? parseIntEnv(process.env[config.minuteEnv], config.defaultMinute, 0, 59)
    : config.defaultMinute;

  const defaultInterval = config.intervalHours ?? 0;
  const rawInterval = config.intervalHoursEnv
    ? parseIntEnv(process.env[config.intervalHoursEnv], defaultInterval, 0, 168)
    : defaultInterval;
  const intervalHours = Math.max(0, Math.min(168, Math.trunc(rawInterval)));
  const useInterval = intervalHours > 0;
  const intervalMs = useInterval ? intervalHours * 60 * 60 * 1000 : 0;

  async function runAndReschedule(): Promise<void> {
    try {
      console.log(`[${config.name}] starting`, useInterval ? { intervalHours } : { hour, minute });
      await config.run();
    } catch (e: any) {
      console.warn(`[${config.name}] failed`, {
        error: String(e?.message || e),
      });
    } finally {
      const ms = useInterval ? intervalMs : msUntilNextLocalTime({ hour, minute, second: 0 });
      console.log(`[${config.name}] next run scheduled`, { inMs: ms });
      setTimeout(() => void runAndReschedule(), ms).unref();
    }
  }

  if (config.firestoreJobId && !useInterval) {
    void maybeCatchUp(config, hour, minute);
  }

  const firstDelay = useInterval ? 0 : msUntilNextLocalTime({ hour, minute, second: 0 });
  console.log(`[${config.name}] scheduler enabled`, useInterval
    ? { intervalHours, firstRun: 'immediate' }
    : { hour, minute, firstDelayMs: firstDelay },
  );
  setTimeout(() => void runAndReschedule(), firstDelay).unref();
  return true;
}

async function maybeCatchUp(
  config: DailyJobConfig,
  hour: number,
  minute: number
): Promise<void> {
  const now = new Date();
  const todayTarget = startOfTodayAtLocalTime(
    { hour, minute, second: 0 },
    now
  );
  if (now.getTime() < todayTarget.getTime()) return;

  try {
    const db = getFirestore();
    const snap = await db
      .collection('Jobs')
      .doc(config.firestoreJobId!)
      .get();
    const data = (snap.data() || {}) as any;
    const lastSuccessAt = toDateOrNull(data?.lastSuccessAt);
    if (lastSuccessAt && lastSuccessAt.getTime() >= todayTarget.getTime())
      return;
  } catch {
    return;
  }

  const delay = config.catchUpDelayMs ?? 30_000;
  console.log(`[${config.name}] catch-up triggered (missed scheduled time)`);
  setTimeout(
    () =>
      void config
        .run()
        .catch((e: any) =>
          console.warn(`[${config.name}] catch-up failed`, {
            error: e?.message,
          })
        ),
    delay
  ).unref();
}
