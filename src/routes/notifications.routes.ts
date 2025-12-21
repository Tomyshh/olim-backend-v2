import { Router } from 'express';
import * as notificationsController from '../controllers/notifications.controller.js';
import { authenticateToken, optionalAuth } from '../middleware/auth.middleware.js';

const router = Router();

// Enregistrer token FCM (peut être fait sans auth complète dans certains cas)
router.post('/token', optionalAuth, notificationsController.registerFCMToken);

// Routes nécessitant authentification
router.use(authenticateToken);

// Liste des notifications
router.get('/', notificationsController.getNotifications);

// Détails d'une notification
router.get('/:notificationId', notificationsController.getNotificationDetail);

// Marquer comme lue
router.patch('/:notificationId/read', notificationsController.markAsRead);

// Marquer toutes comme lues
router.patch('/read-all', notificationsController.markAllAsRead);

// Supprimer une notification
router.delete('/:notificationId', notificationsController.deleteNotification);

// Paramètres notifications
router.get('/settings', notificationsController.getNotificationSettings);
router.patch('/settings', notificationsController.updateNotificationSettings);

export default router;

