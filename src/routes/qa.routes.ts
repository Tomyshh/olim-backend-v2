import express from 'express';
import { authenticateToken } from '../middleware/auth.middleware.js';
import { getQaStats } from '../controllers/qa.controller.js';

const router = express.Router();

// QA Dashboard stats (cache Redis côté backend)
router.get('/stats', authenticateToken, getQaStats);

export default router;


