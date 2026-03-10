import type { Response } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { HttpError } from '../utils/errors.js';
import * as leadsService from '../services/leads.service.js';

function pickString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function pickOptionalString(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  return typeof v === 'string' ? v.trim() : undefined;
}

// ---------------------------------------------------------------------------
// Leads CRUD
// ---------------------------------------------------------------------------

export async function listLeads(req: AuthenticatedRequest, res: Response): Promise<void> {
  const isAdmin = (req as any).isAdmin === true;
  const filters: leadsService.LeadFilters = {
    status: pickOptionalString(req.query.status),
    source: pickOptionalString(req.query.source),
    conseiller_id: isAdmin ? pickOptionalString(req.query.conseiller_id) : req.uid,
    interest_level: pickOptionalString(req.query.interest_level),
    priority: pickOptionalString(req.query.priority),
    country: pickOptionalString(req.query.country),
    language: pickOptionalString(req.query.language),
    search: pickOptionalString(req.query.search),
    archived: req.query.archived === 'true',
    date_from: pickOptionalString(req.query.date_from),
    date_to: pickOptionalString(req.query.date_to),
    score_min: req.query.score_min ? Number(req.query.score_min) : undefined,
    score_max: req.query.score_max ? Number(req.query.score_max) : undefined,
    page: req.query.page ? Number(req.query.page) : 1,
    limit: req.query.limit ? Number(req.query.limit) : 50,
  };

  // Admin can see all leads; if admin passes conseiller_id filter, use it
  if (isAdmin && req.query.conseiller_id) {
    filters.conseiller_id = pickOptionalString(req.query.conseiller_id);
  }
  // Admin with no conseiller_id filter: remove restriction
  if (isAdmin && !req.query.conseiller_id) {
    filters.conseiller_id = undefined;
  }

  const result = await leadsService.listLeads(filters);
  res.json(result);
}

export async function getLeadById(req: AuthenticatedRequest, res: Response): Promise<void> {
  const leadId = pickString(req.params.id);
  if (!leadId) throw new HttpError(400, 'id requis.');

  const lead = await leadsService.getLeadById(leadId);
  if (!lead) throw new HttpError(404, 'Lead introuvable.');

  const isAdmin = (req as any).isAdmin === true;
  if (!isAdmin && lead.conseiller_id !== req.uid) {
    throw new HttpError(403, 'Accès refusé à ce lead.');
  }

  res.json(lead);
}

export async function createLead(req: AuthenticatedRequest, res: Response): Promise<void> {
  const body = req.body || {};
  const firstName = pickString(body.first_name);
  const lastName = pickString(body.last_name);
  const conseillerName = (req as any).conseillerName || '';

  if (!firstName || !lastName) throw new HttpError(400, 'first_name et last_name requis.');

  const payload: leadsService.LeadCreatePayload = {
    first_name: firstName,
    last_name: lastName,
    phone: pickOptionalString(body.phone),
    phone_secondary: pickOptionalString(body.phone_secondary),
    email: pickOptionalString(body.email),
    city: pickOptionalString(body.city),
    country: pickOptionalString(body.country),
    language: pickOptionalString(body.language),
    service_requested: pickOptionalString(body.service_requested),
    interest_level: pickOptionalString(body.interest_level),
    estimated_budget: pickOptionalString(body.estimated_budget),
    urgency: pickOptionalString(body.urgency),
    source_slug: pickOptionalString(body.source_slug),
    conseiller_id: pickOptionalString(body.conseiller_id),
    priority: pickOptionalString(body.priority),
    comments: pickOptionalString(body.comments),
  };

  const lead = await leadsService.createLead(payload, req.uid!);
  res.status(201).json(lead);
}

export async function updateLead(req: AuthenticatedRequest, res: Response): Promise<void> {
  const leadId = pickString(req.params.id);
  if (!leadId) throw new HttpError(400, 'id requis.');

  const existing = await leadsService.getLeadById(leadId);
  if (!existing) throw new HttpError(404, 'Lead introuvable.');

  const isAdmin = (req as any).isAdmin === true;
  if (!isAdmin && existing.conseiller_id !== req.uid) {
    throw new HttpError(403, 'Accès refusé.');
  }

  const body = req.body || {};
  const payload: leadsService.LeadUpdatePayload = {
    first_name: pickOptionalString(body.first_name),
    last_name: pickOptionalString(body.last_name),
    phone: pickOptionalString(body.phone),
    phone_secondary: pickOptionalString(body.phone_secondary),
    email: pickOptionalString(body.email),
    city: pickOptionalString(body.city),
    country: pickOptionalString(body.country),
    language: pickOptionalString(body.language),
    service_requested: pickOptionalString(body.service_requested),
    interest_level: pickOptionalString(body.interest_level),
    estimated_budget: pickOptionalString(body.estimated_budget),
    urgency: pickOptionalString(body.urgency),
    source_slug: pickOptionalString(body.source_slug),
    priority: pickOptionalString(body.priority),
    comments: pickOptionalString(body.comments),
  };

  const lead = await leadsService.updateLead(leadId, payload, req.uid!);
  res.json(lead);
}

export async function updateLeadStatus(req: AuthenticatedRequest, res: Response): Promise<void> {
  const leadId = pickString(req.params.id);
  const statusSlug = pickString(req.body?.status);
  if (!leadId) throw new HttpError(400, 'id requis.');
  if (!statusSlug) throw new HttpError(400, 'status requis.');

  const conseillerName = pickOptionalString(req.body?.conseiller_name);
  const lead = await leadsService.updateLeadStatus(leadId, statusSlug, req.uid!, conseillerName);
  res.json(lead);
}

export async function assignLead(req: AuthenticatedRequest, res: Response): Promise<void> {
  const leadId = pickString(req.params.id);
  const conseillerId = pickString(req.body?.conseiller_id);
  if (!leadId) throw new HttpError(400, 'id requis.');
  if (!conseillerId) throw new HttpError(400, 'conseiller_id requis.');

  const conseillerName = pickOptionalString(req.body?.conseiller_name);
  const lead = await leadsService.assignLead(leadId, conseillerId, req.uid!, conseillerName);
  res.json(lead);
}

export async function archiveLead(req: AuthenticatedRequest, res: Response): Promise<void> {
  const leadId = pickString(req.params.id);
  if (!leadId) throw new HttpError(400, 'id requis.');

  const reason = pickString(req.body?.reason || '');
  const lead = await leadsService.archiveLead(leadId, reason, req.uid!);
  res.json(lead);
}

// ---------------------------------------------------------------------------
// Interactions
// ---------------------------------------------------------------------------

export async function listInteractions(req: AuthenticatedRequest, res: Response): Promise<void> {
  const leadId = pickString(req.params.id);
  if (!leadId) throw new HttpError(400, 'id requis.');

  const data = await leadsService.listInteractions(leadId);
  res.json(data);
}

export async function addInteraction(req: AuthenticatedRequest, res: Response): Promise<void> {
  const leadId = pickString(req.params.id);
  if (!leadId) throw new HttpError(400, 'id requis.');

  const body = req.body || {};
  const interactionType = pickString(body.interaction_type);
  const summary = pickString(body.summary);
  if (!interactionType) throw new HttpError(400, 'interaction_type requis.');
  if (!summary) throw new HttpError(400, 'summary requis.');

  const data = await leadsService.addInteraction(leadId, {
    conseiller_id: req.uid!,
    conseiller_name: pickOptionalString(body.conseiller_name),
    interaction_type: interactionType,
    summary,
    next_action: pickOptionalString(body.next_action),
  });
  res.status(201).json(data);
}

// ---------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------

export async function listReminders(req: AuthenticatedRequest, res: Response): Promise<void> {
  const leadId = pickString(req.params.id);
  if (!leadId) throw new HttpError(400, 'id requis.');

  const data = await leadsService.listReminders(leadId);
  res.json(data);
}

export async function createReminder(req: AuthenticatedRequest, res: Response): Promise<void> {
  const leadId = pickString(req.params.id);
  if (!leadId) throw new HttpError(400, 'id requis.');

  const reminderAt = pickString(req.body?.reminder_at);
  if (!reminderAt) throw new HttpError(400, 'reminder_at requis.');

  const data = await leadsService.createReminder(leadId, {
    conseiller_id: req.uid!,
    reminder_at: reminderAt,
    note: pickOptionalString(req.body?.note),
  });
  res.status(201).json(data);
}

export async function markReminderTreated(req: AuthenticatedRequest, res: Response): Promise<void> {
  const reminderId = pickString(req.params.rid);
  if (!reminderId) throw new HttpError(400, 'rid requis.');

  const data = await leadsService.markReminderTreated(reminderId);
  res.json(data);
}

export async function getDueReminders(req: AuthenticatedRequest, res: Response): Promise<void> {
  const isAdmin = (req as any).isAdmin === true;
  const conseillerId = isAdmin ? pickOptionalString(req.query.conseiller_id) : req.uid;
  const data = await leadsService.getDueReminders(conseillerId);
  res.json(data);
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export async function listTasks(req: AuthenticatedRequest, res: Response): Promise<void> {
  const leadId = pickString(req.params.id);
  if (!leadId) throw new HttpError(400, 'id requis.');

  const data = await leadsService.listTasks(leadId);
  res.json(data);
}

export async function createTask(req: AuthenticatedRequest, res: Response): Promise<void> {
  const leadId = pickString(req.params.id);
  if (!leadId) throw new HttpError(400, 'id requis.');

  const body = req.body || {};
  const taskType = pickString(body.task_type);
  const title = pickString(body.title);
  if (!taskType) throw new HttpError(400, 'task_type requis.');
  if (!title) throw new HttpError(400, 'title requis.');

  const data = await leadsService.createTask(leadId, {
    task_type: taskType,
    title,
    description: pickOptionalString(body.description),
    deadline: pickOptionalString(body.deadline),
    responsible_id: pickString(body.responsible_id) || req.uid!,
    responsible_name: pickOptionalString(body.responsible_name),
    reminder_at: pickOptionalString(body.reminder_at),
  });
  res.status(201).json(data);
}

export async function updateTask(req: AuthenticatedRequest, res: Response): Promise<void> {
  const taskId = pickString(req.params.tid);
  if (!taskId) throw new HttpError(400, 'tid requis.');

  const body = req.body || {};
  const data = await leadsService.updateTask(taskId, {
    status: pickOptionalString(body.status),
    title: pickOptionalString(body.title),
    description: pickOptionalString(body.description),
    deadline: pickOptionalString(body.deadline),
    reminder_at: pickOptionalString(body.reminder_at),
  });
  res.json(data);
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

export async function listAttachments(req: AuthenticatedRequest, res: Response): Promise<void> {
  const leadId = pickString(req.params.id);
  if (!leadId) throw new HttpError(400, 'id requis.');

  const lead = await leadsService.getLeadById(leadId);
  if (!lead) throw new HttpError(404, 'Lead introuvable.');

  const isAdmin = (req as any).isAdmin === true;
  if (!isAdmin && lead.conseiller_id !== req.uid) {
    throw new HttpError(403, 'Accès refusé à ce lead.');
  }

  const data = await leadsService.listAttachments(leadId);
  res.json(data);
}

export async function addAttachment(req: AuthenticatedRequest, res: Response): Promise<void> {
  const leadId = pickString(req.params.id);
  if (!leadId) throw new HttpError(400, 'id requis.');

  const lead = await leadsService.getLeadById(leadId);
  if (!lead) throw new HttpError(404, 'Lead introuvable.');

  const isAdmin = (req as any).isAdmin === true;
  if (!isAdmin && lead.conseiller_id !== req.uid) {
    throw new HttpError(403, 'Accès refusé à ce lead.');
  }

  const body = req.body || {};
  const fileUrl = pickString(body.file_url);
  const fileName = pickString(body.file_name);
  if (!fileUrl) throw new HttpError(400, 'file_url requis.');
  if (!fileName) throw new HttpError(400, 'file_name requis.');

  const conseillerName = (req as any).conseillerName || '';
  const data = await leadsService.addAttachment(leadId, {
    file_url: fileUrl,
    file_name: fileName,
    file_size: typeof body.file_size === 'number' ? body.file_size : undefined,
    mime_type: pickOptionalString(body.mime_type),
    uploaded_by: req.uid!,
    uploaded_by_name: pickOptionalString(body.uploaded_by_name) || conseillerName || undefined,
  });
  res.status(201).json(data);
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export async function getDashboardStats(req: AuthenticatedRequest, res: Response): Promise<void> {
  const data = await leadsService.getDashboardStats();
  res.json(data);
}

export async function getStatsByConseiller(req: AuthenticatedRequest, res: Response): Promise<void> {
  const data = await leadsService.getStatsByConseiller();
  res.json(data);
}

export async function getStatsBySource(req: AuthenticatedRequest, res: Response): Promise<void> {
  const data = await leadsService.getStatsBySource();
  res.json(data);
}

// ---------------------------------------------------------------------------
// Auto-assign
// ---------------------------------------------------------------------------

export async function autoAssignLeads(req: AuthenticatedRequest, res: Response): Promise<void> {
  const result = await leadsService.autoAssignLeads(req.uid!);
  res.json(result);
}

// ---------------------------------------------------------------------------
// Convert lead to client
// ---------------------------------------------------------------------------

export async function convertLead(req: AuthenticatedRequest, res: Response): Promise<void> {
  const leadId = pickString(req.params.id);
  if (!leadId) throw new HttpError(400, 'id requis.');

  const lead = await leadsService.getLeadById(leadId);
  if (!lead) throw new HttpError(404, 'Lead introuvable.');

  await leadsService.updateLeadStatus(leadId, 'converted', req.uid!);

  res.json({
    success: true,
    lead_id: leadId,
    message: 'Lead converti avec succès.',
    lead_data: {
      first_name: lead.first_name,
      last_name: lead.last_name,
      email: lead.email,
      phone: lead.phone,
    },
  });
}

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

export async function getSources(req: AuthenticatedRequest, res: Response): Promise<void> {
  const data = await leadsService.getSources();
  res.json(data);
}

export async function getPipelineStatuses(req: AuthenticatedRequest, res: Response): Promise<void> {
  const data = await leadsService.getPipelineStatuses();
  res.json(data);
}

export async function getConseillers(req: AuthenticatedRequest, res: Response): Promise<void> {
  const data = await leadsService.getConseillers();
  res.json(data);
}

export async function getRoles(req: AuthenticatedRequest, res: Response): Promise<void> {
  const data = await leadsService.getRoles();
  res.json(data);
}
