import type { NextFunction, Request, Response } from 'express';

function nowHr(): bigint {
  return process.hrtime.bigint();
}

function msSince(start: bigint): number {
  return Number(nowHr() - start) / 1_000_000;
}

function getSlowThresholdMs(): number {
  const raw = process.env.SLOW_REQUEST_MS;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 1000;
}

export function responseTimeMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = nowHr();
  const slowMs = getSlowThresholdMs();

  res.on('finish', () => {
    const durationMs = msSince(start);
    const status = res.statusCode;

    // Log uniquement si lente ou erreur serveur, pour éviter de spammer.
    if (durationMs >= slowMs || status >= 500) {
      const uid = typeof (req as any).uid === 'string' ? (req as any).uid : undefined;
      console.log(
        JSON.stringify({
          level: status >= 500 ? 'error' : 'warn',
          msg: 'http_request',
          requestId: req.requestId,
          method: req.method,
          path: req.originalUrl,
          status,
          durationMs: Math.round(durationMs),
          uid
        })
      );
    }
  });

  next();
}


