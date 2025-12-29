import type { NextFunction, Request, Response } from 'express';

/**
 * Express 4 ne gère pas nativement les erreurs de handlers async (Promise rejetées).
 * Ce wrapper les forward vers next(err) pour passer par errorHandler.
 */
export function asyncHandler<
  Req extends Request = Request,
  Res extends Response = Response
>(fn: (req: Req, res: Res, next: NextFunction) => Promise<any> | any) {
  return (req: Req, res: Res, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}


