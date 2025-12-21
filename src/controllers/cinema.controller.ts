import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { getFirestore } from '../config/firebase.js';

export async function getCinemaInfo(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const db = getFirestore();
    const cinemaSnapshot = await db.collection('iCinema').limit(1).get();

    if (cinemaSnapshot.empty) {
      res.json({ cinema: null });
      return;
    }

    const cinema = cinemaSnapshot.docs[0].data();
    res.json({ cinema });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function getMovies(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const db = getFirestore();
    const cinemaSnapshot = await db.collection('iCinema').limit(1).get();

    if (cinemaSnapshot.empty) {
      res.json({ movies: [] });
      return;
    }

    const cinemaData = cinemaSnapshot.docs[0].data();
    const movies = cinemaData.movies || [];

    res.json({ movies });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

