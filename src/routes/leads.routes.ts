import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.middleware.js';
import { requireConseiller, requireAdmin } from '../middleware/conseiller.middleware.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import * as leadsController from '../controllers/leads.controller.js';

const router = Router();

// ---------------------------------------------------------------------------
// Reference data (no admin required)
// ---------------------------------------------------------------------------

router.get(
  '/sources',
  authenticateToken,
  requireConseiller,
  asyncHandler(leadsController.getSources as any)
);

router.get(
  '/pipeline-statuses',
  authenticateToken,
  requireConseiller,
  asyncHandler(leadsController.getPipelineStatuses as any)
);

router.get(
  '/conseillers',
  authenticateToken,
  requireConseiller,
  asyncHandler(leadsController.getConseillers as any)
);

router.get(
  '/roles',
  authenticateToken,
  requireConseiller,
  asyncHandler(leadsController.getRoles as any)
);

router.get(
  '/call-summary-suggestions',
  authenticateToken,
  requireConseiller,
  asyncHandler(leadsController.getCallSummarySuggestions as any)
);

// ---------------------------------------------------------------------------
// Stats (admin only)
// ---------------------------------------------------------------------------

router.get(
  '/stats/dashboard',
  authenticateToken,
  requireAdmin,
  asyncHandler(leadsController.getDashboardStats as any)
);

router.get(
  '/stats/by-conseiller',
  authenticateToken,
  requireAdmin,
  asyncHandler(leadsController.getStatsByConseiller as any)
);

router.get(
  '/stats/by-source',
  authenticateToken,
  requireAdmin,
  asyncHandler(leadsController.getStatsBySource as any)
);

// ---------------------------------------------------------------------------
// Reminders due (before :id routes to avoid conflict)
// ---------------------------------------------------------------------------

router.get(
  '/reminders/due',
  authenticateToken,
  requireConseiller,
  asyncHandler(leadsController.getDueReminders as any)
);

// ---------------------------------------------------------------------------
// Auto-assign (admin only)
// ---------------------------------------------------------------------------

router.post(
  '/auto-assign',
  authenticateToken,
  requireAdmin,
  asyncHandler(leadsController.autoAssignLeads as any)
);

// ---------------------------------------------------------------------------
// Leads CRUD
// ---------------------------------------------------------------------------

router.get(
  '/',
  authenticateToken,
  requireConseiller,
  asyncHandler(leadsController.listLeads as any)
);

router.post(
  '/',
  authenticateToken,
  requireConseiller,
  asyncHandler(leadsController.createLead as any)
);

router.get(
  '/:id',
  authenticateToken,
  requireConseiller,
  asyncHandler(leadsController.getLeadById as any)
);

router.put(
  '/:id',
  authenticateToken,
  requireConseiller,
  asyncHandler(leadsController.updateLead as any)
);

router.patch(
  '/:id/status',
  authenticateToken,
  requireConseiller,
  asyncHandler(leadsController.updateLeadStatus as any)
);

router.patch(
  '/:id/assign',
  authenticateToken,
  requireConseiller,
  asyncHandler(leadsController.assignLead as any)
);

router.delete(
  '/:id',
  authenticateToken,
  requireConseiller,
  asyncHandler(leadsController.archiveLead as any)
);

// ---------------------------------------------------------------------------
// Interactions
// ---------------------------------------------------------------------------

router.get(
  '/:id/interactions',
  authenticateToken,
  requireConseiller,
  asyncHandler(leadsController.listInteractions as any)
);

router.post(
  '/:id/interactions',
  authenticateToken,
  requireConseiller,
  asyncHandler(leadsController.addInteraction as any)
);

router.get(
  '/:id/calls/drafts',
  authenticateToken,
  requireConseiller,
  asyncHandler(leadsController.listCallDrafts as any)
);

router.post(
  '/:id/calls',
  authenticateToken,
  requireConseiller,
  asyncHandler(leadsController.createCallDraft as any)
);

router.get(
  '/:id/calls/:cid',
  authenticateToken,
  requireConseiller,
  asyncHandler(leadsController.getCallById as any)
);

router.patch(
  '/:id/calls/:cid',
  authenticateToken,
  requireConseiller,
  asyncHandler(leadsController.updateCall as any)
);

router.post(
  '/:id/calls/:cid/validate',
  authenticateToken,
  requireConseiller,
  asyncHandler(leadsController.validateCall as any)
);

// ---------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------

router.get(
  '/:id/reminders',
  authenticateToken,
  requireConseiller,
  asyncHandler(leadsController.listReminders as any)
);

router.post(
  '/:id/reminders',
  authenticateToken,
  requireConseiller,
  asyncHandler(leadsController.createReminder as any)
);

router.patch(
  '/:id/reminders/:rid',
  authenticateToken,
  requireConseiller,
  asyncHandler(leadsController.markReminderTreated as any)
);

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

router.get(
  '/:id/tasks',
  authenticateToken,
  requireConseiller,
  asyncHandler(leadsController.listTasks as any)
);

router.post(
  '/:id/tasks',
  authenticateToken,
  requireConseiller,
  asyncHandler(leadsController.createTask as any)
);

router.patch(
  '/:id/tasks/:tid',
  authenticateToken,
  requireConseiller,
  asyncHandler(leadsController.updateTask as any)
);

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

router.get(
  '/:id/attachments',
  authenticateToken,
  requireConseiller,
  asyncHandler(leadsController.listAttachments as any)
);

router.post(
  '/:id/attachments',
  authenticateToken,
  requireConseiller,
  asyncHandler(leadsController.addAttachment as any)
);

// ---------------------------------------------------------------------------
// Convert
// ---------------------------------------------------------------------------

router.post(
  '/:id/convert',
  authenticateToken,
  requireConseiller,
  asyncHandler(leadsController.convertLead as any)
);

export default router;
