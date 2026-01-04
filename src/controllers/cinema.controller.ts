import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { getFirestore } from '../config/firebase.js';
import { getOrSetJsonWithLock } from '../services/cache.service.js';

export async function getCinemaInfo(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const ttlSeconds = Number(process.env.CINEMA_REDIS_TTL_SECONDS || 60);
    const { value, cacheStatus } = await getOrSetJsonWithLock({
      key: 'olimcrm:cinema:info:v1',
      ttlSeconds: Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? ttlSeconds : 60,
      lockTtlSeconds: 10,
      fn: async () => {
        const db = getFirestore();
        const cinemaSnapshot = await db.collection('iCinema').limit(1).get();
        if (cinemaSnapshot.empty) return { cinema: null };
        const cinema = cinemaSnapshot.docs[0].data();
        return { cinema };
      }
    });
    res.setHeader('X-Cache', cacheStatus);
    res.json(value);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function getMovies(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const ttlSeconds = Number(process.env.CINEMA_REDIS_TTL_SECONDS || 60);
    const { value, cacheStatus } = await getOrSetJsonWithLock({
      key: 'olimcrm:cinema:movies:v1',
      ttlSeconds: Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? ttlSeconds : 60,
      lockTtlSeconds: 10,
      fn: async () => {
        const db = getFirestore();
        const cinemaSnapshot = await db.collection('iCinema').limit(1).get();
        if (cinemaSnapshot.empty) return { movies: [] };
        const cinemaData = cinemaSnapshot.docs[0].data();
        const movies = cinemaData.movies || [];
        return { movies };
      }
    });
    res.setHeader('X-Cache', cacheStatus);
    res.json(value);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

