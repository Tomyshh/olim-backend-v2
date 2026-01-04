type Waiter = {
  resolve: () => void;
  reject: (err: Error) => void;
  timer?: NodeJS.Timeout;
};

type Bucket = {
  current: number;
  queue: Waiter[];
};

const buckets = new Map<string, Bucket>();

export class ConcurrencyLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConcurrencyLimitError';
  }
}

function getBucket(key: string): Bucket {
  const existing = buckets.get(key);
  if (existing) return existing;
  const b: Bucket = { current: 0, queue: [] };
  buckets.set(key, b);
  return b;
}

async function acquire(key: string, limit: number, waitTimeoutMs: number): Promise<() => void> {
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error(`Limite de concurrence invalide pour ${key}: ${limit}`);
  }
  const b = getBucket(key);
  if (b.current < limit) {
    b.current += 1;
    return () => release(key);
  }

  return await new Promise<() => void>((resolve, reject) => {
    const waiter: Waiter = {
      resolve: () => {
        b.current += 1;
        resolve(() => release(key));
      },
      reject
    };

    if (waitTimeoutMs > 0 && Number.isFinite(waitTimeoutMs)) {
      waiter.timer = setTimeout(() => {
        // Retire ce waiter de la queue
        const idx = b.queue.indexOf(waiter);
        if (idx >= 0) b.queue.splice(idx, 1);
        reject(new ConcurrencyLimitError(`Service surchargé (${key}).`));
      }, waitTimeoutMs);
    }

    b.queue.push(waiter);
  });
}

function release(key: string): void {
  const b = buckets.get(key);
  if (!b) return;

  b.current = Math.max(0, b.current - 1);
  const next = b.queue.shift();
  if (!next) return;

  if (next.timer) clearTimeout(next.timer);
  // Donne le slot au prochain
  next.resolve();
}

export async function runWithConcurrencyLimit<T>(params: {
  key: string;
  limit: number;
  waitTimeoutMs?: number;
  fn: () => Promise<T>;
}): Promise<T> {
  const releaseFn = await acquire(params.key, params.limit, params.waitTimeoutMs ?? 10_000);
  try {
    return await params.fn();
  } finally {
    releaseFn();
  }
}


