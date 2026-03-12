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
  conversion_plan?: string;
  subscription_type?: string;
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

function pickDefined<T extends Record<string, any>>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

function normalizeSummary(summary: string | undefined): string | null {
  if (summary === undefined) return undefined as any;
  const trimmed = summary.trim();
  return trimmed === '' ? null : trimmed;
}

function buildInteractionSnapshot(row: any) {
  return {
    summary: row.summary ?? null,
    detailed_comment: row.detailed_comment ?? null,
    lead_answered: row.lead_answered ?? null,
    status_slug: row.status_slug ?? null,
    reminder_at: row.reminder_at ?? null,
    next_action: row.next_action ?? null,
    is_draft: row.is_draft ?? false,
  };
}

async function touchLeadInteraction(leadId: string) {
  await supabase
    .from('leads')
    .update({ last_interaction_at: new Date().toISOString() })
    .eq('id', leadId);
}

async function syncLeadStatusFromCall(leadId: string, statusSlug?: string | null) {
  if (!statusSlug) return;
  const statusId = await resolveStatusId(statusSlug);
  if (!statusId) return;

  await supabase
    .from('leads')
    .update({
      status_id: statusId,
      last_interaction_at: new Date().toISOString(),
    })
    .eq('id', leadId);
}

async function syncReminderFromCall(interaction: any) {
  const reminderAt = interaction.reminder_at ?? null;
  const note =
    interaction.summary && String(interaction.summary).trim() !== ''
      ? `Rappel suite appel: ${interaction.summary}`
      : 'Rappel suite appel CRM';

  const { data: existing, error: existingError } = await supabase
    .from('lead_reminders')
    .select('id, treated')
    .eq('call_interaction_id', interaction.id)
    .maybeSingle();

  if (existingError) throw existingError;

  if (!reminderAt) {
    if (existing && existing.treated !== true) {
      const { error } = await supabase
        .from('lead_reminders')
        .update({
          treated: true,
          treated_at: new Date().toISOString(),
          note: 'Rappel annulé depuis l’appel CRM',
        })
        .eq('id', existing.id);
      if (error) throw error;
    }
    return;
  }

  if (existing) {
    const { error } = await supabase
      .from('lead_reminders')
      .update({
        conseiller_id: interaction.conseiller_id,
        reminder_at: reminderAt,
        note,
        treated: false,
        treated_at: null,
      })
      .eq('id', existing.id);
    if (error) throw error;
    return;
  }

  const { error } = await supabase
    .from('lead_reminders')
    .insert({
      lead_id: interaction.lead_id,
      conseiller_id: interaction.conseiller_id,
      reminder_at: reminderAt,
      note,
      call_interaction_id: interaction.id,
    });
  if (error) throw error;
}

async function insertInteractionEditAudit(params: {
  interactionId: string;
  leadId: string;
  editedBy: string;
  editedByName?: string;
  oldValues: Record<string, any>;
  newValues: Record<string, any>;
}) {
  const { oldValues, newValues } = params;
  if (JSON.stringify(oldValues) === JSON.stringify(newValues)) return;

  const { error } = await supabase
    .from('lead_interaction_edits')
    .insert({
      lead_interaction_id: params.interactionId,
      lead_id: params.leadId,
      edited_by: params.editedBy,
      edited_by_name: params.editedByName ?? null,
      old_values: oldValues,
      new_values: newValues,
    });

  if (error) throw error;
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

export function computeHeatBonus(lead: Record<string, any>): number {
  let bonus = 0;

  const createdAt = lead.created_at ? new Date(lead.created_at) : null;
  if (createdAt) {
    const ageDays = (Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24);
    if (ageDays < 7) bonus += 15;
    else if (ageDays < 30) bonus += 10;
    else if (ageDays < 90) bonus += 5;
  }

  const slug = lead.pipeline_status?.slug ?? lead.status_slug ?? '';
  if (slug === 'to_finalize') bonus += 20;
  else if (slug === 'to_recall') bonus += 10;
  else if (slug === 'no_answer') bonus += 5;
  else if (slug === 'converted') bonus += 25;
  else if (slug === 'lost') bonus -= 15;

  const summary = (lead.last_call_summary ?? '').toLowerCase();
  if (summary) {
    if (summary.includes('intéressé') && !summary.includes('pas intéressé') && !summary.includes('non intéressé')) bonus += 15;
    else if (summary.includes('pas intéressé') || summary.includes('non intéressé')) bonus -= 10;
    if (summary.includes('inscrire') || summary.includes('inscription')) bonus += 20;
    if (summary.includes('documents') || summary.includes('dossier')) bonus += 10;
    if (summary.includes('réfléchir')) bonus += 5;
    if (summary.includes('ne répond pas') || summary.includes('injoignable')) bonus -= 5;
  }

  return bonus;
}

async function recalculateLeadHeat(leadId: string) {
  const lead = await getLeadById(leadId);
  const baseScore = await computeLeadScore(lead);
  const bonus = computeHeatBonus(lead);
  const finalScore = Math.max(0, baseScore + bonus);
  const interestLevel = deriveInterestLevel(finalScore);

  await supabase.from('leads').update({
    score: finalScore,
    interest_level: interestLevel,
  }).eq('id', leadId);
}

async function updateLeadLastCallFields(leadId: string, interaction: any) {
  const updateData: Record<string, any> = {
    last_call_summary: interaction.summary || null,
    last_call_date: interaction.validated_at || interaction.created_at,
    last_call_by_name: interaction.conseiller_name || interaction.validated_by_name || null,
  };

  if (interaction.reminder_at) {
    updateData.next_reminder_at = interaction.reminder_at;
  }

  await supabase.from('leads').update(updateData).eq('id', leadId);
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
    'conversion_plan', 'subscription_type',
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

export async function updateLeadStatus(
  leadId: string,
  statusSlug: string,
  updatedBy: string,
  conseillerName?: string,
  conversionData?: { conversion_plan?: string; subscription_type?: string },
) {
  const statusId = await resolveStatusId(statusSlug);
  if (!statusId) throw new Error(`Status inconnu: ${statusSlug}`);

  if (statusSlug === 'converted') {
    if (!conversionData?.conversion_plan || !conversionData?.subscription_type) {
      throw new Error('Le forfait et le type d\'abonnement sont obligatoires pour convertir un lead.');
    }
  }

  const updateData: Record<string, any> = {
    status_id: statusId,
    last_interaction_at: new Date().toISOString(),
  };

  if (statusSlug === 'converted') {
    updateData.converted_at = new Date().toISOString();
    updateData.conversion_plan = conversionData!.conversion_plan;
    updateData.subscription_type = conversionData!.subscription_type;
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

  await recalculateLeadHeat(leadId);

  const refreshed = await getLeadById(leadId);
  return refreshed;
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

export async function listInteractions(
  leadId: string,
  options?: {
    includeDrafts?: boolean;
    draftOnly?: boolean;
    onlyCalls?: boolean;
    conseillerId?: string;
  },
) {
  let query = supabase
    .from('lead_interactions')
    .select('*')
    .eq('lead_id', leadId)
    .order('created_at', { ascending: false });

  if (options?.draftOnly) {
    query = query.eq('is_draft', true);
  } else if (!options?.includeDrafts) {
    query = query.or('is_draft.eq.false,is_draft.is.null');
  }

  if (options?.onlyCalls) {
    query = query.eq('interaction_type', 'call');
  }

  if (options?.conseillerId) {
    query = query.eq('conseiller_id', options.conseillerId);
  }

  const { data, error } = await query;

  if (error) {
    // Fallback: if is_draft column doesn't exist yet, retry without the filter
    if (String(error.message).includes('is_draft')) {
      const { data: fallback, error: fallbackErr } = await supabase
        .from('lead_interactions')
        .select('*')
        .eq('lead_id', leadId)
        .order('created_at', { ascending: false });

      if (fallbackErr) throw fallbackErr;
      return fallback ?? [];
    }
    throw error;
  }
  return data ?? [];
}

export async function getInteractionById(leadId: string, interactionId: string) {
  const { data, error } = await supabase
    .from('lead_interactions')
    .select('*')
    .eq('lead_id', leadId)
    .eq('id', interactionId)
    .single();

  if (error) throw error;
  return data;
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
      is_draft: false,
      updated_at: new Date().toISOString(),
      updated_by: payload.conseiller_id,
      updated_by_name: payload.conseiller_name ?? null,
    })
    .select()
    .single();

  if (error) throw error;

  await touchLeadInteraction(leadId);

  return data;
}

export async function createCallDraft(leadId: string, payload: {
  conseiller_id: string;
  conseiller_name?: string;
}) {
  const { data, error } = await supabase
    .from('lead_interactions')
    .insert({
      lead_id: leadId,
      conseiller_id: payload.conseiller_id,
      conseiller_name: payload.conseiller_name ?? null,
      interaction_type: 'call',
      summary: '',
      is_draft: true,
      updated_at: new Date().toISOString(),
      updated_by: payload.conseiller_id,
      updated_by_name: payload.conseiller_name ?? null,
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function listCallDrafts(leadId: string, conseillerId?: string) {
  try {
    return await listInteractions(leadId, {
      includeDrafts: true,
      draftOnly: true,
      onlyCalls: true,
      conseillerId,
    });
  } catch {
    return [];
  }
}

export async function updateCallInteraction(leadId: string, interactionId: string, payload: {
  summary?: string;
  detailed_comment?: string;
  lead_answered?: boolean;
  reminder_at?: string | null;
  status_slug?: string | null;
  next_action?: string | null;
  is_draft?: boolean;
  edited_by: string;
  edited_by_name?: string;
}) {
  const existing = await getInteractionById(leadId, interactionId);
  if (existing.interaction_type !== 'call') {
    throw new Error('Interaction d’appel introuvable.');
  }

  const oldSnapshot = buildInteractionSnapshot(existing);
  const updateData = pickDefined({
    summary: payload.summary !== undefined ? payload.summary : undefined,
    detailed_comment: payload.detailed_comment,
    lead_answered: payload.lead_answered,
    reminder_at: payload.reminder_at,
    status_slug: payload.status_slug,
    next_action: payload.next_action,
    is_draft: payload.is_draft,
    updated_at: new Date().toISOString(),
    updated_by: payload.edited_by,
    updated_by_name: payload.edited_by_name ?? null,
  });

  const { data, error } = await supabase
    .from('lead_interactions')
    .update(updateData)
    .eq('lead_id', leadId)
    .eq('id', interactionId)
    .select()
    .single();

  if (error) throw error;

  const newSnapshot = buildInteractionSnapshot(data);
  await insertInteractionEditAudit({
    interactionId,
    leadId,
    editedBy: payload.edited_by,
    editedByName: payload.edited_by_name,
    oldValues: oldSnapshot,
    newValues: newSnapshot,
  });

  if (data.is_draft === false) {
    await syncLeadStatusFromCall(leadId, data.status_slug);
    await syncReminderFromCall(data);
    await touchLeadInteraction(leadId);
  }

  return data;
}

export async function validateCallInteraction(leadId: string, interactionId: string, payload: {
  summary: string;
  detailed_comment?: string;
  lead_answered?: boolean;
  reminder_at?: string | null;
  status_slug?: string | null;
  next_action?: string | null;
  validated_by: string;
  validated_by_name?: string;
}) {
  const existing = await getInteractionById(leadId, interactionId);
  if (existing.interaction_type !== 'call') {
    throw new Error('Interaction d’appel introuvable.');
  }

  const oldSnapshot = buildInteractionSnapshot(existing);
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('lead_interactions')
    .update({
      summary: payload.summary,
      detailed_comment: payload.detailed_comment ?? existing.detailed_comment ?? null,
      lead_answered: payload.lead_answered ?? existing.lead_answered ?? null,
      reminder_at: payload.reminder_at ?? null,
      status_slug: payload.status_slug ?? null,
      next_action: payload.next_action ?? null,
      is_draft: false,
      validated_at: existing.validated_at ?? now,
      validated_by: payload.validated_by,
      validated_by_name: payload.validated_by_name ?? null,
      updated_at: now,
      updated_by: payload.validated_by,
      updated_by_name: payload.validated_by_name ?? null,
    })
    .eq('lead_id', leadId)
    .eq('id', interactionId)
    .select()
    .single();

  if (error) throw error;

  const newSnapshot = buildInteractionSnapshot(data);
  await insertInteractionEditAudit({
    interactionId,
    leadId,
    editedBy: payload.validated_by,
    editedByName: payload.validated_by_name,
    oldValues: oldSnapshot,
    newValues: newSnapshot,
  });

  await syncLeadStatusFromCall(leadId, data.status_slug);
  await syncReminderFromCall(data);
  await touchLeadInteraction(leadId);
  await updateLeadLastCallFields(leadId, data);
  await recalculateLeadHeat(leadId);

  return data;
}

export async function getCallSummarySuggestions(limit = 8) {
  const { data, error } = await supabase
    .from('lead_interactions')
    .select('summary')
    .eq('interaction_type', 'call')
    .eq('is_draft', false)
    .order('created_at', { ascending: false })
    .limit(500);

  if (error) throw error;

  const counts = new Map<string, number>();
  for (const row of data ?? []) {
    const summary = typeof row.summary === 'string' ? row.summary.trim() : '';
    if (!summary) continue;
    counts.set(summary, (counts.get(summary) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([summary, count]) => ({ summary, count }));
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
