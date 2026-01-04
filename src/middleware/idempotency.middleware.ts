import type { NextFunction, Request, Response } from 'express';
import { getRedisClientOptional } from '../config/redis.js';

type StoredResponse = {
  status: number;
  headers?: Record<string, string>;
  body: any;
  storedAt: string;
};

type IdempotencyOptions = {
  /** Namespace de clé (ex: "idem:requests:create") */
  prefix: string;
  /** TTL en secondes pour la réponse stockée */
  ttlSeconds: number;
  /** TTL court pour le lock "in progress" */
  inFlightTtlSeconds?: number;
  /** Si true: inclut uid dans la clé quand dispo */
  preferUid?: boolean;
};

function readIdempotencyKey(req: Request): string {
  const raw = req.headers['idempotency-key'] ?? req.headers['Idempotency-Key'];
  const key = typeof raw === 'string' ? raw : Array.isArray(raw) ? String(raw[0] ?? '') : '';
  // borne pour éviter clés géantes / attaques
  return key.trim().slice(0, 128);
}

function buildRedisKey(req: Request, opt: IdempotencyOptions, idempotencyKey: string): string {
  const uid = opt.preferUid && typeof (req as any).uid === 'string' ? (req as any).uid : '';
  const subject = uid ? `uid:${uid}` : 'anon';
  return `${opt.prefix}:${subject}:${req.method}:${req.originalUrl}:${idempotencyKey}`;
}

export function idempotencyMiddleware(opt: IdempotencyOptions) {
  const inFlightTtl = opt.inFlightTtlSeconds ?? 30;

  return async (req: Request, res: Response, next: NextFunction) => {
    const idemKey = readIdempotencyKey(req);
    if (!idemKey) return next(); // pas de header => pas d’idempotency

    const redis = await getRedisClientOptional();
    if (!redis) return next(); // Redis absent => bypass

    const key = buildRedisKey(req, opt, idemKey);
    const lockKey = `lock:${key}`;

    // 1) HIT ? (réponse déjà stockée)
    const existing = await redis.get(key);
    if (existing) {
      try {
        const parsed = JSON.parse(existing) as StoredResponse;
        res.setHeader('X-Idempotency-Status', 'HIT');
        res.setHeader('X-Request-Id', req.requestId || '');
        if (parsed.headers) {
          for (const [h, v] of Object.entries(parsed.headers)) {
            if (h.toLowerCase() === 'x-request-id') continue;
            res.setHeader(h, v);
          }
        }
        res.status(parsed.status).json(parsed.body);
        return;
      } catch {
        // si corrompu => on continue et on le remplacera
      }
    }

    // 2) lock in-flight: un seul traitement pour ce Idempotency-Key
    const lockToken = `${Date.now()}:${Math.random().toString(16).slice(2)}`;
    const lockRes = await redis.set(lockKey, lockToken, { NX: true, EX: inFlightTtl });
    if (lockRes !== 'OK') {
      res.setHeader('Retry-After', '1');
      res.setHeader('X-Idempotency-Status', 'IN_PROGRESS');
      res.status(409).json({ message: 'Requête déjà en cours de traitement. Veuillez réessayer.' });
      return;
    }

    // 3) On capture la réponse pour la stocker ensuite
    res.setHeader('X-Idempotency-Status', 'MISS');
    const originalJson = res.json.bind(res);

    (res as any).json = (body: any) => {
      // On laisse Express écrire la réponse, puis on stocke best-effort
      const status = res.statusCode;
      const payload: StoredResponse = {
        status,
        body,
        storedAt: new Date().toISOString()
      };

      // Stockage: on cache 2xx-4xx (évite doubles écritures) mais pas 5xx (souvent transitoire)
      Promise.resolve()
        .then(async () => {
          if (status >= 500) return;
          await redis.set(key, JSON.stringify(payload), { EX: opt.ttlSeconds });
        })
        .catch(() => {})
        .finally(async () => {
          // Release lock best-effort si on est propriétaire
          try {
            const current = await redis.get(lockKey);
            if (current === lockToken) await redis.del(lockKey);
          } catch {
            // ignore
          }
        });

      return originalJson(body);
    };

    // Si erreur via next(err), on libère le lock (best-effort)
    const onFinish = async () => {
      try {
        const current = await redis.get(lockKey);
        if (current === lockToken) await redis.del(lockKey);
      } catch {
        // ignore
      }
    };
    res.once('close', () => void onFinish());

    next();
  };
}


