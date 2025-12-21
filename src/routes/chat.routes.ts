import { Router } from 'express';
import * as chatController from '../controllers/chat.controller.js';
import { authenticateToken } from '../middleware/auth.middleware.js';

const router = Router();

// Toutes les routes nécessitent une authentification
router.use(authenticateToken);

// Liste des conversations
router.get('/conversations', chatController.getConversations);

// Messages d'une conversation
router.get('/conversations/:conversationId/messages', chatController.getMessages);

// Créer une conversation
router.post('/conversations', chatController.createConversation);

// Envoyer un message
router.post('/conversations/:conversationId/messages', chatController.sendMessage);

// Marquer messages comme lus
router.patch('/conversations/:conversationId/read', chatController.markAsRead);

// Upload fichier dans chat
router.post('/conversations/:conversationId/files', chatController.uploadChatFile);

export default router;

