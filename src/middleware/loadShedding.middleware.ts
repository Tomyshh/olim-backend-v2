import type { NextFunction, Request, Response } from 'express';

let overloaded = false;

export function setOverloaded(value: boolean): void {
  overloaded = value;
}

export function loadSheddingMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (process.env.LOAD_SHEDDING_ENABLED !== 'true') return next();
  if (!overloaded) return next();
  // Laisse passer health + openapi
  if (req.path === '/health' || req.path === '/openapi.yaml') return next();
  res.status(503).json({ message: 'Service surchargé. Veuillez réessayer.' });
}


