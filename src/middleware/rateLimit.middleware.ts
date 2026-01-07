import type { NextFunction, Request, Response } from 'express';
import { consumeRateLimit } from '../services/rateLimit.service.js';
import { getClientIp } from '../utils/errors.js';

type RateLimitOptions = {
  /** Préfixe de clé Redis (ex: "rl:global") */
  prefix: string;
  /** Nombre de requêtes autorisées sur la fenêtre */
  limit: number;
  /** Fenêtre en secondes */
  windowSeconds: number;
  /**
   * Par défaut: clé = ip. Si true, on préfère uid quand dispo (auth).
   * Important: protège mieux contre plusieurs users derrière une même IP.
   */
  preferUid?: boolean;
  /** Si true, on ne bloque pas en cas d’erreur Redis (fail-open) */
  bypassOnError?: boolean;
  /** Message renvoyé en 429 */
  message?: string;
};

function buildKey(req: Request, opt: RateLimitOptions): string {
  const uid = opt.preferUid && typeof (req as any).uid === 'string' ? (req as any).uid : '';
  const subject = uid || getClientIp(req as any);
  // Evite clés trop longues / caractères bizarres
  const safe = subject.replace(/[^a-zA-Z0-9:._-]/g, '_').slice(0, 120) || 'unknown';
  return `${opt.prefix}:${safe}`;
}

export function rateLimitMiddleware(opt: RateLimitOptions) {
  const message = opt.message || 'Trop de requêtes.';
  const bypassOnError = opt.bypassOnError ?? true;

  return async (req: Request, res: Response, next: NextFunction) => {
    // Si le client a déjà coupé la connexion, on évite de déclencher le parsing JSON plus loin.
    if ((req as any).aborted || (req as any).destroyed) return;

    try {
      const key = buildKey(req, opt);
      const r = await consumeRateLimit({ key, limit: opt.limit, windowSeconds: opt.windowSeconds });
      if (!r.allowed) {
        res.setHeader('Retry-After', String(r.retryAfterSeconds));
        res.status(429).json({ message });
        return;
      }
      // Optionnel: expose le budget restant (utile en debug)
      if (process.env.RATE_LIMIT_DEBUG === 'true') {
        res.setHeader('X-RateLimit-Remaining', String(r.remaining));
      }
      if ((req as any).aborted || (req as any).destroyed || (res as any).writableEnded) return;
      next();
    } catch (err) {
      if (bypassOnError) return next();
      next(err);
    }
  };
}


