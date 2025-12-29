import { Response } from 'express';

export class HttpError extends Error {
  status: number;
  code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function sendError(res: Response, status: number, message: string): void {
  res.status(status).json({ message });
}

export function getClientIp(req: { headers: any; ip?: string }): string {
  // Render/Proxy: X-Forwarded-For peut contenir une liste "client, proxy1, proxy2"
  const xff = (req.headers?.['x-forwarded-for'] || req.headers?.['X-Forwarded-For']) as
    | string
    | undefined;
  if (xff?.trim()) return xff.split(',')[0]!.trim();
  return (req.ip || '').trim() || 'unknown';
}


