import { Router } from 'express';
import { authenticateToken } from '../../middleware/auth.middleware.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { v1GetJobStatus } from '../../controllers/v1/jobs.controller.js';

const router = Router();

// GET /v1/jobs/:jobId
router.get('/jobs/:jobId', authenticateToken, asyncHandler(v1GetJobStatus as any));

export default router;


