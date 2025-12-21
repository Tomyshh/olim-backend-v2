import { Router } from 'express';
import * as appointmentsController from '../controllers/appointments.controller.js';
import { authenticateToken } from '../middleware/auth.middleware.js';

const router = Router();

// Toutes les routes nécessitent une authentification
router.use(authenticateToken);

// Liste des rendez-vous
router.get('/', appointmentsController.getAppointments);

// Détails d'un rendez-vous
router.get('/:appointmentId', appointmentsController.getAppointmentDetail);

// Création d'un rendez-vous
router.post('/', appointmentsController.createAppointment);

// Mise à jour d'un rendez-vous
router.patch('/:appointmentId', appointmentsController.updateAppointment);

// Annulation d'un rendez-vous
router.delete('/:appointmentId', appointmentsController.cancelAppointment);

// Créneaux disponibles
router.get('/slots/available', appointmentsController.getAvailableSlots);

export default router;

