import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { supabase } from '../services/supabase.service.js';
import { getOrSetJsonWithLock } from '../services/cache.service.js';

export async function getCinemaInfo(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const ttlSeconds = Number(process.env.CINEMA_REDIS_TTL_SECONDS || 60);
    const { value, cacheStatus } = await getOrSetJsonWithLock({
      key: 'olimcrm:cinema:info:v1',
      ttlSeconds: Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? ttlSeconds : 60,
      lockTtlSeconds: 10,
      fn: async () => {
        const { data: movies, error } = await supabase
          .from('icinema_movies')
          .select('*, icinema_seances(*)');

        if (error) throw error;
        if (!movies || movies.length === 0) return { cinema: null };

        const mappedMovies = movies.map((m: any) => ({
          ...m,
          // Legacy aliases
          title: m.title ?? '',
          language: m.language ?? '',
          ageRating: m.age_rating ?? '',
          duration: m.duration ?? '',
          genre: m.genre ?? '',
          imageLarge: m.image_large ?? '',
          imageLong: m.image_long ?? '',
          createdAt: m.created_at ?? '',
          icinema_seances: (m.icinema_seances ?? []).map((s: any) => ({
            ...s,
            movieId: s.movie_id ?? null,
            cinemaName: s.cinema_name ?? '',
            hallName: s.hall_name ?? '',
            screenType: s.screen_type ?? '',
            createdAt: s.created_at ?? '',
          })),
        }));
        return { cinema: { movies: mappedMovies } };
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
        const { data: movies, error } = await supabase
          .from('icinema_movies')
          .select('*, icinema_seances(*)');

        if (error) throw error;

        const mappedMovies = (movies || []).map((m: any) => ({
          ...m,
          // Legacy aliases
          title: m.title ?? '',
          language: m.language ?? '',
          ageRating: m.age_rating ?? '',
          duration: m.duration ?? '',
          genre: m.genre ?? '',
          imageLarge: m.image_large ?? '',
          imageLong: m.image_long ?? '',
          createdAt: m.created_at ?? '',
          icinema_seances: (m.icinema_seances ?? []).map((s: any) => ({
            ...s,
            movieId: s.movie_id ?? null,
            cinemaName: s.cinema_name ?? '',
            hallName: s.hall_name ?? '',
            screenType: s.screen_type ?? '',
            createdAt: s.created_at ?? '',
          })),
        }));
        return { movies: mappedMovies };
      }
    });
    res.setHeader('X-Cache', cacheStatus);
    res.json(value);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

