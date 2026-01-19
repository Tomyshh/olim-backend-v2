import { Request, Response, NextFunction } from 'express';

export function errorHandler(
  err: any,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // Logs structurés (utile sur Render) sans exposer de secrets.
  if (err?.twilio) {
    console.error('Error (Twilio):', {
      status: err.status || err.statusCode || 500,
      message: err.message,
      twilio: err.twilio
    });
  } else if (err?.sms) {
    console.error('Error (SMS):', {
      status: err.status || err.statusCode || 500,
      message: err.message,
      sms: err.sms
    });
  } else {
    console.error('Error:', err);
  }

  const status = err.status || err.statusCode || 500;
  const message = err.message || 'Internal server error';

  res.status(status).json({
    requestId: (req as any).requestId || null,
    message,
    // compat legacy (certaines routes existantes renvoient encore {error})
    error: message,
    ...(typeof err?.code === 'string' && err.code.trim() ? { code: err.code } : {}),
    // Expose un identifiant PayMe non sensible, utile au CRM pour mapper un message propre.
    ...(Number.isFinite(Number(err?.errorCode)) ? { paymeErrorCode: Number(err.errorCode) } : {}),
    ...(process.env.EXPOSE_ERROR_DETAILS === 'true' && err?.twilio && { details: { provider: 'twilio', ...err.twilio } }),
    ...(process.env.EXPOSE_ERROR_DETAILS === 'true' && err?.sms && { details: { provider: 'sms', ...err.sms } }),
    ...(process.env.EXPOSE_ERROR_DETAILS === 'true' &&
      err?.payme &&
      typeof err.payme === 'object' && { details: { provider: 'payme', ...err.payme } }),
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
}

