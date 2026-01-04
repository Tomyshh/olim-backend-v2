import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';

function pickIncomingRequestId(req: Request): string | null {
  const h = req.headers['x-request-id'];
  if (typeof h === 'string' && h.trim()) return h.trim().slice(0, 128);
  if (Array.isArray(h) && typeof h[0] === 'string' && h[0].trim()) return h[0].trim().slice(0, 128);
  return null;
}

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = pickIncomingRequestId(req);
  const requestId = incoming || randomUUID();

  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  next();
}


