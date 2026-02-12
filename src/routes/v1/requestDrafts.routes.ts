import { Router } from 'express';
import { authenticateToken } from '../../middleware/auth.middleware.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import {
  v1CreateRequestDraft,
  v1DeleteRequestDraft,
  v1FinalizeRequestDraft,
  v1ListRequestDrafts,
  v1PatchRequestDraft
} from '../../controllers/v1/requestDrafts.controller.js';

const router = Router();

// POST /v1/request-drafts
router.post('/request-drafts', authenticateToken, asyncHandler(v1CreateRequestDraft as any));

// GET /v1/request-drafts
router.get('/request-drafts', authenticateToken, asyncHandler(v1ListRequestDrafts as any));

// PATCH /v1/request-drafts/:draftId
router.patch('/request-drafts/:draftId', authenticateToken, asyncHandler(v1PatchRequestDraft as any));

// DELETE /v1/request-drafts/:draftId
router.delete('/request-drafts/:draftId', authenticateToken, asyncHandler(v1DeleteRequestDraft as any));

// POST /v1/request-drafts/:draftId/finalize (optionnel)
router.post('/request-drafts/:draftId/finalize', authenticateToken, asyncHandler(v1FinalizeRequestDraft as any));

export default router;

