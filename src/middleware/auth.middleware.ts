import { Request, Response, NextFunction } from 'express';
import { getAuth } from '../config/firebase.js';

export interface AuthenticatedRequest extends Request {
  uid?: string;
  user?: any;
}

export async function authenticateToken(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ message: 'Vous devez être connecté.' });
      return;
    }

    const token = authHeader.split('Bearer ')[1];
    const auth = getAuth();
    const decodedToken = await auth.verifyIdToken(token);
    
    req.uid = decodedToken.uid;
    req.user = decodedToken;
    
    next();
  } catch (error: any) {
    console.error('Auth error:', error);
    res.status(401).json({ message: 'Vous devez être connecté.' });
  }
}

export async function optionalAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;
    
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split('Bearer ')[1];
      const auth = getAuth();
      const decodedToken = await auth.verifyIdToken(token);
      req.uid = decodedToken.uid;
      req.user = decodedToken;
    }
    
    next();
  } catch (error) {
    // Continue without auth if token is invalid
    next();
  }
}

