import { supabase } from './supabase.service.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LeadFilters {
  status?: string;
  source?: string;
  conseiller_id?: string;
  interest_level?: string;
  priority?: string;
  country?: string;
  language?: string;
  search?: string;
  archived?: boolean;
  date_from?: string;
  date_to?: string;
  score_min?: number;
  score_max?: number;
  page?: number;
  limit?: number;
}

export interface LeadCreatePayload {
  first_name: string;
  last_name: string;
  phone?: string;
  phone_secondary?: string;
  email?: string;
  city?: string;
  country?: string;
  language?: string;
  service_requested?: string;
  interest_level?: string;
  estimated_budget?: string;
  urgency?: string;
  source_slug?: string;
  conseiller_id?: string;
  priority?: string;
  comments?: string;
}

export interface LeadUpdatePayload {
  first_name?: string;
  last_name?: string;
  phone?: string;
  phone_secondary?: string;
  email?: string;
  city?: string;
  country?: string;
  language?: string;
  service_requested?: string;
  interest_level?: string;
  estimated_budget?: string;
  urgency?: string;
  source_slug?: string;
  priority?: string;
  comments?: string;
}

interface ScoreRule {
  condition_field: string;
  condition_operator: string;
  condition_value: string;
  score_delta: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function resolveSourceId(slug: string): Promise<string | null> {
  const { data } = await supabase
    .from('lead_sources')
    .select('id')
    .eq('slug', slug)
    .single();
  return data?.id ?? null;
}

async function resolveStatusId(slug: string): Promise<string | null> {
  const { data } = await supabase
    .from('lead_pipeline_statuses')
    .select('id')
    .eq('slug', slug)
    .single();
  return data?.id ?? null;
}

async function resolveStatusSlug(statusId: string): Promise<string | null> {
  const { data } = await supabase
    .from('lead_pipeline_statuses')
    .select('slug')
    .eq('id', statusId)
    .single();
  return data?.slug ?? null;
}

// ---------------------------------------------------------------------------
// Lead scoring
// ---------------------------------------------------------------------------

export async function computeLeadScore(lead: Record<string, any>): Promise<number> {
  const { data: rules } = await supabase
    .from('lead_score_rules')
    .select('*')
    .eq('is_active', true);

  if (!rules || rules.length === 0) return 0;

  let score = 0;
  for (const rule of rules as ScoreRule[]) {
    const fieldValue = String(lead[rule.condition_field] ?? '').toLowerCase();
    const condValue = rule.condition_value.toLowerCase();

    let match = false;
    switch (rule.condition_operator) {
      case 'equals':
        match = fieldValue === condValue;
        break;
      case 'contains':
        match = fieldValue.includes(condValue);
        break;
      case 'gt':
        match = Number(fieldValue) > Number(condValue);
        break;
      case 'lt':
        match = Number(fieldValue) < Number(condValue);
        break;
      case 'gte':
        match = Number(fieldValue) >= Number(condValue);
        break;
      case 'lte':
        match = Number(fieldValue) <= Number(condValue);
        break;
      case 'exists':
        match = fieldValue !== '' && fieldValue !== 'null' && fieldValue !== 'undefined';
        break;
    }

    if (match) score += rule.score_delta;
  }

  return Math.max(0, score);
}

function deriveInterestLevel(score: number): 'hot' | 'warm' | 'cold' {
  if (score >= 40) return 'hot';
  if (score >= 15) return 'warm';
  return 'cold';
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function listLeads(filters: LeadFilters) {
  const page = Math.max(1, filters.page ?? 1);
  const limit = Math.min(200, Math.max(1, filters.limit ?? 50));
  const offset = (page - 1) * limit;

  let query = supabase
    .from('leads')
    .select(`
      *,
      source:lead_sources(*),
      pipeline_status:lead_pipeline_statuses(*)
    `, { count: 'exact' });

  if (!filters.archived) {
    query = query.is('archived_at', null);
  } else {
    query = query.not('archived_at', 'is', null);
  }

  if (filters.conseiller_id) {
    query = query.eq('conseiller_id', filters.conseiller_id);
  }
  if (filters.status) {
    const statusId = await resolveStatusId(filters.status);
    if (statusId) query = query.eq('status_id', statusId);
  }
  if (filters.source) {
    const sourceId = await resolveSourceId(filters.source);
    if (sourceId) query = query.eq('source_id', sourceId);
  }
  if (filters.interest_level) {
    query = query.eq('interest_level', filters.interest_level);
  }
  if (filters.priority) {
    query = query.eq('priority', filters.priority);
  }
  if (filters.country) {
    query = query.ilike('country', `%${filters.country}%`);
  }
  if (filters.language) {
    query = query.eq('language', filters.language);
  }
  if (filters.date_from) {
    query = query.gte('created_at', filters.date_from);
  }
  if (filters.date_to) {
    query = query.lte('created_at', filters.date_to);
  }
  if (typeof filters.score_min === 'number') {
    query = query.gte('score', filters.score_min);
  }
  if (typeof filters.score_max === 'number') {
    query = query.lte('score', filters.score_max);
  }
  if (filters.search) {
    const s = `%${filters.search}%`;
    query = query.or(`first_name.ilike.${s},last_name.ilike.${s},email.ilike.${s},phone.ilike.${s}`);
  }

  query = query.order('created_at', { ascending: false });
  query = query.range(offset, offset + limit - 1);

  const { data, error, count } = await query;
  if (error) throw error;

  return {
    leads: data ?? [],
    total: count ?? 0,
    page,
    limit,
    totalPages: Math.ceil((count ?? 0) / limit),
  };
}

export async function getLeadById(leadId: string) {
  const { data, error } = await supabase
    .from('leads')
    .select(`
      *,
      source:lead_sources(*),
      pipeline_status:lead_pipeline_statuses(*)
    `)
    .eq('id', leadId)
    .single();

  if (error) throw error;
  return data;
}

export async function createLead(payload: LeadCreatePayload, createdBy: string) {
  const statusId = await resolveStatusId('new');
  let sourceId: string | null = null;
  if (payload.source_slug) {
    sourceId = await resolveSourceId(payload.source_slug);
  }

  const leadDataForScoring: Record<string, any> = {
    ...payload,
    source_slug: payload.source_slug,
  };
  const score = await computeLeadScore(leadDataForScoring);
  const interestLevel = payload.interest_level || deriveInterestLevel(score);

  const insertData: Record<string, any> = {
    first_name: payload.first_name,
    last_name: payload.last_name,
    phone: payload.phone ?? null,
    phone_secondary: payload.phone_secondary ?? null,
    email: payload.email ?? null,
    city: payload.city ?? null,
    country: payload.country ?? null,
    language: payload.language ?? 'fr',
    service_requested: payload.service_requested ?? null,
    interest_level: interestLevel,
    estimated_budget: payload.estimated_budget ?? null,
    urgency: payload.urgency ?? 'medium',
    status_id: statusId,
    score,
    priority: payload.priority ?? 'medium',
    source_id: sourceId,
    conseiller_id: payload.conseiller_id ?? null,
    assigned_at: payload.conseiller_id ? new Date().toISOString() : null,
    comments: payload.comments ?? null,
  };

  const { data, error } = await supabase
    .from('leads')
    .insert(insertData)
    .select(`
      *,
      source:lead_sources(*),
      pipeline_status:lead_pipeline_statuses(*)
    `)
    .single();

  if (error) throw error;

  // Log creation interaction
  await supabase.from('lead_interactions').insert({
    lead_id: data.id,
    conseiller_id: createdBy,
    interaction_type: 'note',
    summary: 'Lead créé',
    metadata: { action: 'created' },
  });

  return data;
}

export async function updateLead(leadId: string, payload: LeadUpdatePayload, updatedBy: string) {
  const updateData: Record<string, any> = {};

  const fields: (keyof LeadUpdatePayload)[] = [
    'first_name', 'last_name', 'phone', 'phone_secondary', 'email',
    'city', 'country', 'language', 'service_requested', 'interest_level',
    'estimated_budget', 'urgency', 'priority', 'comments',
  ];

  for (const field of fields) {
    if (payload[field] !== undefined) {
      updateData[field] = payload[field];
    }
  }

  if (payload.source_slug) {
    const sourceId = await resolveSourceId(payload.source_slug);
    if (sourceId) updateData.source_id = sourceId;
  }

  // Recalculate score if relevant fields changed
  const existing = await getLeadById(leadId);
  const merged = { ...existing, ...updateData };
  if (existing.source) merged.source_slug = existing.source.slug;
  if (payload.source_slug) merged.source_slug = payload.source_slug;

  const newScore = await computeLeadScore(merged);
  updateData.score = newScore;
  if (!payload.interest_level) {
    updateData.interest_level = deriveInterestLevel(newScore);
  }

  const { data, error } = await supabase
    .from('leads')
    .update(updateData)
    .eq('id', leadId)
    .select(`
      *,
      source:lead_sources(*),
      pipeline_status:lead_pipeline_statuses(*)
    `)
    .single();

  if (error) throw error;

  await supabase.from('lead_interactions').insert({
    lead_id: leadId,
    conseiller_id: updatedBy,
    interaction_type: 'note',
    summary: 'Fiche lead mise à jour',
    metadata: { action: 'updated', fields: Object.keys(updateData) },
  });

  return data;
}

export async function updateLeadStatus(leadId: string, statusSlug: string, updatedBy: string, conseillerName?: string) {
  const statusId = await resolveStatusId(statusSlug);
  if (!statusId) throw new Error(`Status inconnu: ${statusSlug}`);

  const updateData: Record<string, any> = {
    status_id: statusId,
    last_interaction_at: new Date().toISOString(),
  };

  if (statusSlug === 'converted') {
    updateData.converted_at = new Date().toISOString();
  }

  const { data, error } = await supabase
    .from('leads')
    .update(updateData)
    .eq('id', leadId)
    .select(`
      *,
      source:lead_sources(*),
      pipeline_status:lead_pipeline_statuses(*)
    `)
    .single();

  if (error) throw error;

  await supabase.from('lead_interactions').insert({
    lead_id: leadId,
    conseiller_id: updatedBy,
    conseiller_name: conseillerName,
    interaction_type: 'status_change',
    summary: `Statut changé vers "${statusSlug}"`,
    metadata: { action: 'status_change', new_status: statusSlug },
  });

  return data;
}

export async function assignLead(leadId: string, conseillerId: string, assignedBy: string, conseillerName?: string) {
  const { data, error } = await supabase
    .from('leads')
    .update({
      conseiller_id: conseillerId,
      assigned_at: new Date().toISOString(),
    })
    .eq('id', leadId)
    .select(`
      *,
      source:lead_sources(*),
      pipeline_status:lead_pipeline_statuses(*)
    `)
    .single();

  if (error) throw error;

  await supabase.from('lead_interactions').insert({
    lead_id: leadId,
    conseiller_id: assignedBy,
    interaction_type: 'note',
    summary: `Lead attribué à ${conseillerName || conseillerId}`,
    metadata: { action: 'assigned', assigned_to: conseillerId },
  });

  return data;
}

export async function archiveLead(leadId: string, reason: string, archivedBy: string) {
  const { data, error } = await supabase
    .from('leads')
    .update({
      archived_at: new Date().toISOString(),
      archive_reason: reason || 'Archivé manuellement',
    })
    .eq('id', leadId)
    .select()
    .single();

  if (error) throw error;

  await supabase.from('lead_interactions').insert({
    lead_id: leadId,
    conseiller_id: archivedBy,
    interaction_type: 'note',
    summary: `Lead archivé: ${reason || 'Archivé manuellement'}`,
    metadata: { action: 'archived', reason },
  });

  return data;
}

// ---------------------------------------------------------------------------
// Interactions
// ---------------------------------------------------------------------------

export async function listInteractions(leadId: string) {
  const { data, error } = await supabase
    .from('lead_interactions')
    .select('*')
    .eq('lead_id', leadId)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return data ?? [];
}

export async function addInteraction(leadId: string, payload: {
  conseiller_id: string;
  conseiller_name?: string;
  interaction_type: string;
  summary: string;
  next_action?: string;
}) {
  const { data, error } = await supabase
    .from('lead_interactions')
    .insert({
      lead_id: leadId,
      conseiller_id: payload.conseiller_id,
      conseiller_name: payload.conseiller_name,
      interaction_type: payload.interaction_type,
      summary: payload.summary,
      next_action: payload.next_action ?? null,
    })
    .select()
    .single();

  if (error) throw error;

  await supabase
    .from('leads')
    .update({ last_interaction_at: new Date().toISOString() })
    .eq('id', leadId);

  return data;
}

// ---------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------

export async function listReminders(leadId: string) {
  const { data, error } = await supabase
    .from('lead_reminders')
    .select('*')
    .eq('lead_id', leadId)
    .order('reminder_at', { ascending: true });

  if (error) throw error;
  return data ?? [];
}

export async function createReminder(leadId: string, payload: {
  conseiller_id: string;
  reminder_at: string;
  note?: string;
}) {
  const { data, error } = await supabase
    .from('lead_reminders')
    .insert({
      lead_id: leadId,
      conseiller_id: payload.conseiller_id,
      reminder_at: payload.reminder_at,
      note: payload.note ?? null,
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function markReminderTreated(reminderId: string) {
  const { data, error } = await supabase
    .from('lead_reminders')
    .update({
      treated: true,
      treated_at: new Date().toISOString(),
    })
    .eq('id', reminderId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function getDueReminders(conseillerId?: string) {
  let query = supabase
    .from('v_lead_reminders_due')
    .select('*')
    .order('reminder_at', { ascending: true });

  if (conseillerId) {
    query = query.eq('conseiller_id', conseillerId);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export async function listTasks(leadId: string) {
  const { data, error } = await supabase
    .from('lead_tasks')
    .select('*')
    .eq('lead_id', leadId)
    .order('deadline', { ascending: true, nullsFirst: false });

  if (error) throw error;
  return data ?? [];
}

export async function createTask(leadId: string, payload: {
  task_type: string;
  title: string;
  description?: string;
  deadline?: string;
  responsible_id: string;
  responsible_name?: string;
  reminder_at?: string;
}) {
  const { data, error } = await supabase
    .from('lead_tasks')
    .insert({
      lead_id: leadId,
      task_type: payload.task_type,
      title: payload.title,
      description: payload.description ?? null,
      deadline: payload.deadline ?? null,
      responsible_id: payload.responsible_id,
      responsible_name: payload.responsible_name ?? null,
      reminder_at: payload.reminder_at ?? null,
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function updateTask(taskId: string, payload: {
  status?: string;
  title?: string;
  description?: string;
  deadline?: string;
  reminder_at?: string;
}) {
  const updateData: Record<string, any> = {};
  if (payload.status !== undefined) {
    updateData.status = payload.status;
    if (payload.status === 'completed') {
      updateData.completed_at = new Date().toISOString();
    }
  }
  if (payload.title !== undefined) updateData.title = payload.title;
  if (payload.description !== undefined) updateData.description = payload.description;
  if (payload.deadline !== undefined) updateData.deadline = payload.deadline;
  if (payload.reminder_at !== undefined) updateData.reminder_at = payload.reminder_at;

  const { data, error } = await supabase
    .from('lead_tasks')
    .update(updateData)
    .eq('id', taskId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

export async function listAttachments(leadId: string) {
  const { data, error } = await supabase
    .from('lead_attachments')
    .select('*')
    .eq('lead_id', leadId)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return data ?? [];
}

export async function addAttachment(leadId: string, payload: {
  file_url: string;
  file_name: string;
  file_size?: number;
  mime_type?: string;
  uploaded_by: string;
  uploaded_by_name?: string;
}) {
  const { data, error } = await supabase
    .from('lead_attachments')
    .insert({
      lead_id: leadId,
      ...payload,
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

// ---------------------------------------------------------------------------
// Dashboard stats
// ---------------------------------------------------------------------------

export async function getDashboardStats() {
  const { data: leads, error: leadsErr } = await supabase
    .from('leads')
    .select('id, status_id, conseiller_id, source_id, created_at, converted_at, last_interaction_at, interest_level, score')
    .is('archived_at', null);

  if (leadsErr) throw leadsErr;

  const { data: statuses } = await supabase.from('lead_pipeline_statuses').select('*');
  const { data: sources } = await supabase.from('lead_sources').select('*');

  const statusMap = new Map((statuses ?? []).map((s: any) => [s.id, s]));
  const sourceMap = new Map((sources ?? []).map((s: any) => [s.id, s]));

  const allLeads = leads ?? [];
  const total = allLeads.length;

  const converted = allLeads.filter((l: any) => {
    const st = statusMap.get(l.status_id);
    return st?.slug === 'converted';
  }).length;

  const lost = allLeads.filter((l: any) => {
    const st = statusMap.get(l.status_id);
    return st?.slug === 'lost';
  }).length;

  // By conseiller
  const byConseiller: Record<string, { total: number; converted: number }> = {};
  for (const l of allLeads as any[]) {
    const cid = l.conseiller_id || 'unassigned';
    if (!byConseiller[cid]) byConseiller[cid] = { total: 0, converted: 0 };
    byConseiller[cid].total++;
    const st = statusMap.get(l.status_id);
    if (st?.slug === 'converted') byConseiller[cid].converted++;
  }

  // By source
  const bySource: Record<string, { label: string; total: number; converted: number }> = {};
  for (const l of allLeads as any[]) {
    const src = sourceMap.get(l.source_id);
    const key = src?.slug || 'unknown';
    if (!bySource[key]) bySource[key] = { label: src?.label || 'Inconnu', total: 0, converted: 0 };
    bySource[key].total++;
    const st = statusMap.get(l.status_id);
    if (st?.slug === 'converted') bySource[key].converted++;
  }

  // By status
  const byStatus: Record<string, { label: string; count: number; color: string }> = {};
  for (const l of allLeads as any[]) {
    const st = statusMap.get(l.status_id);
    const key = st?.slug || 'unknown';
    if (!byStatus[key]) byStatus[key] = { label: st?.label || 'Inconnu', count: 0, color: st?.color || '#999' };
    byStatus[key].count++;
  }

  // Average response time
  let totalResponseHours = 0;
  let responseSamples = 0;
  for (const l of allLeads as any[]) {
    if (l.last_interaction_at && l.created_at) {
      const diff = new Date(l.last_interaction_at).getTime() - new Date(l.created_at).getTime();
      if (diff > 0) {
        totalResponseHours += diff / (1000 * 60 * 60);
        responseSamples++;
      }
    }
  }

  return {
    total,
    converted,
    lost,
    conversionRate: total > 0 ? Math.round((converted / total) * 10000) / 100 : 0,
    avgResponseTimeHours: responseSamples > 0 ? Math.round((totalResponseHours / responseSamples) * 100) / 100 : null,
    byConseiller,
    bySource,
    byStatus,
    hotLeads: allLeads.filter((l: any) => l.interest_level === 'hot').length,
    warmLeads: allLeads.filter((l: any) => l.interest_level === 'warm').length,
    coldLeads: allLeads.filter((l: any) => l.interest_level === 'cold').length,
  };
}

export async function getStatsByConseiller() {
  const { data, error } = await supabase
    .from('v_lead_stats_by_conseiller')
    .select('*');

  if (error) throw error;
  return data ?? [];
}

export async function getStatsBySource() {
  const { data, error } = await supabase
    .from('v_lead_stats_by_source')
    .select('*');

  if (error) throw error;
  return data ?? [];
}

// ---------------------------------------------------------------------------
// Auto-assign
// ---------------------------------------------------------------------------

export async function autoAssignLeads(assignedBy: string) {
  // Get unassigned leads
  const { data: unassigned, error: uErr } = await supabase
    .from('leads')
    .select('id, language, source_id')
    .is('conseiller_id', null)
    .is('archived_at', null);

  if (uErr) throw uErr;
  if (!unassigned || unassigned.length === 0) return { assigned: 0 };

  // Get active rules sorted by priority
  const { data: rules } = await supabase
    .from('lead_assignment_rules')
    .select('*')
    .eq('is_active', true)
    .order('priority', { ascending: false });

  if (!rules || rules.length === 0) return { assigned: 0, message: 'No active rules' };

  // Get workload per conseiller (count of active leads)
  const { data: workloadData } = await supabase
    .from('leads')
    .select('conseiller_id')
    .is('archived_at', null)
    .not('conseiller_id', 'is', null);

  const workload: Record<string, number> = {};
  for (const l of (workloadData ?? []) as any[]) {
    workload[l.conseiller_id] = (workload[l.conseiller_id] || 0) + 1;
  }

  let assignedCount = 0;
  for (const lead of unassigned as any[]) {
    let targetConseiller: string | null = null;

    for (const rule of rules as any[]) {
      const conditions = rule.conditions || {};

      if (rule.rule_type === 'source' && conditions.source_id === lead.source_id && rule.conseiller_id) {
        targetConseiller = rule.conseiller_id;
        break;
      }
      if (rule.rule_type === 'language' && conditions.language === lead.language && rule.conseiller_id) {
        targetConseiller = rule.conseiller_id;
        break;
      }
      if (rule.rule_type === 'workload' && rule.conseiller_id) {
        const currentLoad = workload[rule.conseiller_id] || 0;
        const maxLoad = conditions.max_leads ?? 100;
        if (currentLoad < maxLoad) {
          targetConseiller = rule.conseiller_id;
          break;
        }
      }
    }

    if (targetConseiller) {
      await supabase
        .from('leads')
        .update({
          conseiller_id: targetConseiller,
          assigned_at: new Date().toISOString(),
        })
        .eq('id', lead.id);

      workload[targetConseiller] = (workload[targetConseiller] || 0) + 1;
      assignedCount++;
    }
  }

  return { assigned: assignedCount, total_unassigned: unassigned.length };
}

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

export async function getSources() {
  const { data, error } = await supabase
    .from('lead_sources')
    .select('*')
    .eq('is_active', true)
    .order('display_order', { ascending: true });

  if (error) throw error;
  return data ?? [];
}

export async function getPipelineStatuses() {
  const { data, error } = await supabase
    .from('lead_pipeline_statuses')
    .select('*')
    .order('display_order', { ascending: true });

  if (error) throw error;
  return data ?? [];
}

export async function getConseillers() {
  const { data, error } = await supabase
    .from('conseillers')
    .select(`
      *,
      role:roles(*)
    `)
    .eq('is_active', true)
    .order('name', { ascending: true });

  if (error) throw error;
  return data ?? [];
}

export async function getRoles() {
  const { data, error } = await supabase
    .from('roles')
    .select('*')
    .order('display_order', { ascending: true });

  if (error) throw error;
  return data ?? [];
}
