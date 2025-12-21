import { Router } from 'express';
import * as cinemaController from '../controllers/cinema.controller.js';
import { optionalAuth } from '../middleware/auth.middleware.js';

const router = Router();

// Informations cinéma (peut être public)
router.get('/', optionalAuth, cinemaController.getCinemaInfo);

// Films disponibles
router.get('/movies', optionalAuth, cinemaController.getMovies);

export default router;

