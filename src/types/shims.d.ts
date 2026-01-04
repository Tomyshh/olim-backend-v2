declare module 'cors';
declare module 'morgan';
declare module 'multer';

declare global {
  namespace Express {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface Request {
      requestId?: string;
    }
  }
}

export {};


