import { Router } from 'express';
import multer from 'multer';
import * as chatController from '../controllers/chat.controller.js';
import { authenticateToken } from '../middleware/auth.middleware.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

router.use(authenticateToken);

router.get('/conversations', asyncHandler(chatController.getConversations as any));
router.get('/conversations/:conversationId/messages', asyncHandler(chatController.getMessages as any));
router.post('/conversations', asyncHandler(chatController.createConversation as any));
router.post('/conversations/:conversationId/messages', asyncHandler(chatController.sendMessage as any));
router.patch('/conversations/:conversationId/read', asyncHandler(chatController.markAsRead as any));
router.post('/conversations/:conversationId/files', upload.array('files'), asyncHandler(chatController.uploadChatFile as any));

export default router;
