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
  } else {
    console.error('Error:', err);
  }

  const status = err.status || err.statusCode || 500;
  const message = err.message || 'Internal server error';

  res.status(status).json({
    message,
    // compat legacy (certaines routes existantes renvoient encore {error})
    error: message,
    ...(process.env.EXPOSE_ERROR_DETAILS === 'true' && err?.twilio && { details: { provider: 'twilio', ...err.twilio } }),
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
}

