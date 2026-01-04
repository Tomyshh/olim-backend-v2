import { createClient } from 'redis';

type AnyRedisClient = ReturnType<typeof createClient>;

let client: AnyRedisClient | null = null;
let connectPromise: Promise<AnyRedisClient> | null = null;

function buildRedisClient(): AnyRedisClient {
  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error('REDIS_URL is not set');
  }

  const c = createClient({ url });

  c.on('error', (err) => {
    // Ne pas faire crasher le process sur un problème réseau: on log et on retente au prochain appel.
    console.error('❌ Redis error:', err);
  });
  c.on('connect', () => console.log('🧠 Redis connect'));
  c.on('ready', () => console.log('✅ Redis ready'));
  c.on('end', () => console.log('🧠 Redis connection ended'));

  return c;
}

/**
 * Retourne un client Redis connecté si REDIS_URL est défini.
 * Si REDIS_URL est absent, retourne null (le code appelant peut bypass le cache).
 */
export async function getRedisClientOptional(): Promise<AnyRedisClient | null> {
  if (!process.env.REDIS_URL) return null;

  if (client?.isOpen) return client;
  if (connectPromise) return connectPromise;

  client = buildRedisClient();

  connectPromise = (async () => {
    await client!.connect();
    return client!;
  })();

  try {
    return await connectPromise;
  } catch (err) {
    // Reset pour permettre un retry ultérieur
    connectPromise = null;
    try {
      await client?.quit();
    } catch {
      // ignore
    }
    client = null;
    console.error('❌ Redis connect failed:', err);
    return null;
  } finally {
    connectPromise = null;
  }
}

export async function closeRedisClient(): Promise<void> {
  try {
    if (client?.isOpen) {
      await client.quit();
    }
  } catch {
    // ignore
  } finally {
    client = null;
    connectPromise = null;
  }
}


