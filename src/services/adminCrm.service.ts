import { supabase } from './supabase.service.js';
import { getFirestore } from '../config/firebase.js';
import { dualWriteConseiller, dualWriteToSupabase, resolveSupabaseClientId } from './dualWrite.service.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClientFilters {
  search?: string;
  membership?: string;
  seniority?: string;
  subscription_status?: string;
  activity?: string;
  payment_status?: string;
  page?: number;
  limit?: number;
  sort_by?: string;
  sort_order?: 'asc' | 'desc';
}

export interface RequestFilters {
  status?: string;
  request_type?: string;
  category?: string;
  assigned_to?: string;
  client_id?: string;
  urgency?: string;
  search?: string;
  date_from?: string;
  date_to?: string;
  unread_only?: boolean;
  page?: number;
  limit?: number;
  sort_by?: string;
  sort_order?: 'asc' | 'desc';
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

export async function listClients(filters: ClientFilters) {
  const page = filters.page ?? 1;
  const limit = Math.min(filters.limit ?? 50, 200);
  const offset = (page - 1) * limit;

  const selectWithRelations = `
    *,
    subscriptions(id, plan_type, membership_type, price_cents, currency, payme_status, is_unpaid, payme_sub_id, start_at, end_at, created_at, updated_at),
    family_members(id, first_name, last_name, status),
    client_addresses(id, label, address1, city, country, is_primary)
  `;

  let query = supabase.from('clients').select(selectWithRelations, { count: 'exact' });

  if (filters.search) {
    query = query.or(
      `first_name.ilike.%${filters.search}%,last_name.ilike.%${filters.search}%,email.ilike.%${filters.search}%,tz.ilike.%${filters.search}%`
    );
  }
  if (filters.membership) {
    query = query.eq('membership_type', filters.membership);
  }
  if (filters.subscription_status) {
    query = query.eq('subscription_status', filters.subscription_status);
  }
  if (filters.payment_status) {
    query = query.eq('membership_status', filters.payment_status);
  }
  if (filters.seniority) {
    query = query.eq('seniority', filters.seniority);
  }
  if (filters.activity) {
    query = query.eq('activity', filters.activity);
  }

  const sortCol = filters.sort_by || 'created_at';
  const sortAsc = filters.sort_order === 'asc';
  query = query.order(sortCol, { ascending: sortAsc }).range(offset, offset + limit - 1);

  let result = await query;
  if (result.error) {
    const errMsg = result.error.message?.toLowerCase() ?? '';
    if (
      errMsg.includes('relation') ||
      errMsg.includes('embed') ||
      errMsg.includes('does not exist') ||
      errMsg.includes('column')
    ) {
      query = supabase.from('clients').select('*', { count: 'exact' });
      if (filters.search) {
        query = query.or(
          `first_name.ilike.%${filters.search}%,last_name.ilike.%${filters.search}%,email.ilike.%${filters.search}%,tz.ilike.%${filters.search}%`
        );
      }
      if (filters.membership) query = query.eq('membership_type', filters.membership);
      if (filters.subscription_status) query = query.eq('subscription_status', filters.subscription_status);
      query = query.order(sortCol, { ascending: sortAsc }).range(offset, offset + limit - 1);
      result = await query;
    }
    if (result.error) {
      throw new Error(`Supabase listClients error: ${result.error.message}`);
    }
  }

  return {
    clients: result.data ?? [],
    total: result.count ?? 0,
    page,
    limit,
  };
}

export async function getClientById(clientId: string) {
  const { data, error } = await supabase
    .from('clients')
    .select(`
      *,
      subscriptions(*),
      family_members(*),
      client_addresses(*),
      payment_credentials(id, card_name, card_masked, card_type, is_subscription_card, is_default, created_at),
      client_documents(id, document_type, for_who, is_valid, created_at)
    `)
    .eq('id', clientId)
    .single();

  if (error) throw new Error(`Supabase getClientById error: ${error.message}`);
  return data;
}

export async function getClientByFirebaseUid(firebaseUid: string) {
  const { data, error } = await supabase
    .from('clients')
    .select(`
      *,
      subscriptions(*),
      family_members(*),
      client_addresses(*),
      payment_credentials(id, card_name, card_masked, card_type, is_subscription_card, is_default, created_at),
      client_documents(id, document_type, for_who, is_valid, created_at)
    `)
    .eq('firebase_uid', firebaseUid)
    .single();

  if (error) throw new Error(`Supabase getClientByFirebaseUid error: ${error.message}`);
  return data;
}

export async function updateClient(clientId: string, updates: Record<string, unknown>) {
  const { data, error } = await supabase
    .from('clients')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', clientId)
    .select()
    .single();

  if (error) throw new Error(`Supabase updateClient error: ${error.message}`);
  return data;
}

export async function deleteClient(clientId: string) {
  const { error } = await supabase
    .from('clients')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', clientId);

  if (error) throw new Error(`Supabase deleteClient error: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Requests (admin view — all clients)
// ---------------------------------------------------------------------------

export async function listRequestsAdmin(filters: RequestFilters) {
  const pageLimit = Math.min(filters.limit ?? 50, 200);
  const page = filters.page ?? 1;
  const offset = (page - 1) * pageLimit;

  const sortCol = filters.sort_by || 'request_date';
  const sortAsc = filters.sort_order === 'asc';

  let query = supabase
    .from('requests')
    .select('*', { count: 'exact' })
    .order(sortCol, { ascending: sortAsc });

  if (filters.status) query = query.eq('status', filters.status);
  if (filters.request_type) query = query.eq('request_type', filters.request_type);
  if (filters.category) query = query.eq('request_category', filters.category);
  if (filters.assigned_to) query = query.eq('assigned_to', filters.assigned_to);
  if (filters.urgency) query = query.eq('urgence_conseiller', filters.urgency);
  if (filters.date_from) query = query.gte('request_date', filters.date_from);
  if (filters.date_to) query = query.lte('request_date', filters.date_to);
  if (filters.unread_only) query = query.eq('is_opened', false);
  if (filters.search) {
    query = query.or(
      `request_description.ilike.%${filters.search}%,first_name.ilike.%${filters.search}%,last_name.ilike.%${filters.search}%,assigned_to.ilike.%${filters.search}%`
    );
  }

  query = query.range(offset, offset + pageLimit - 1);
  const { data, error, count } = await query;
  if (error) throw new Error(`Supabase listRequestsAdmin error: ${error.message}`);

  const requests = (data ?? []).map(formatRequestRow);

  return { requests, total: count ?? 0, page, limit: pageLimit };
}

function formatRequestRow(r: Record<string, any>) {
  return {
    id: r.firebase_request_id ?? r.id,
    supabaseId: r.id,
    clientId: r.user_id,
    client_id: r.client_id,
    status: r.status ?? '',
    requestType: r.request_type ?? '',
    requestCategory: r.request_category ?? '',
    requestSubCategory: r.request_sub_category ?? '',
    assignedTo: r.assigned_to ?? '',
    assignedToUid: r.assigned_to_conseiller_id ?? r.assigned_to ?? null,
    description: r.request_description ?? '',
    requestDate: r.request_date,
    closingDate: r.closing_date,
    isOpened: r.is_opened ?? false,
    firstName: r.first_name ?? '',
    lastName: r.last_name ?? '',
    email: r.email ?? '',
    membershipType: r.membership_type ?? '',
    priority: r.priority,
    difficulty: r.difficulty,
    rating: r.rating,
    source: r.source ?? '',
    platform: r.platform ?? '',
    isRdv: r.is_rdv ?? false,
    urgenceConseiller: r.urgence_conseiller ?? '',
    conseillerNote: r.conseiller_note ?? '',
    responseText: r.response_text ?? '',
    createdBy: r.created_by ?? '',
    tags: r.tags ?? [],
    uploadedFiles: r.uploaded_files ?? [],
    availableDays: r.available_days ?? [],
    availableHours: r.available_hours ?? [],
    clientComment: r.client_comment ?? '',
    ...r,
  };
}

// ---------------------------------------------------------------------------
// Single Request Detail (admin)
// ---------------------------------------------------------------------------

export async function getRequestById(requestId: string) {
  let query = supabase
    .from('requests')
    .select('*')
    .or(`firebase_request_id.eq.${requestId},id.eq.${requestId}`)
    .limit(1)
    .maybeSingle();

  const { data, error } = await query;
  if (error) throw new Error(`Supabase getRequestById error: ${error.message}`);
  if (!data) return null;

  let clientInfo = null;
  if (data.client_id) {
    const { data: c } = await supabase
      .from('clients')
      .select('id, firebase_uid, first_name, last_name, email, phone, membership_type, membership_status, seniority, teoudat_zeout, koupat_holim, birthday, created_at')
      .eq('id', data.client_id)
      .maybeSingle();
    clientInfo = c;
  } else if (data.user_id) {
    const { data: c } = await supabase
      .from('clients')
      .select('id, firebase_uid, first_name, last_name, email, phone, membership_type, membership_status, seniority, teoudat_zeout, koupat_holim, birthday, created_at')
      .eq('firebase_uid', data.user_id)
      .maybeSingle();
    clientInfo = c;
  }

  return { ...formatRequestRow(data), client: clientInfo };
}

// ---------------------------------------------------------------------------
// Update Request (admin)
// ---------------------------------------------------------------------------

export async function updateRequestAdmin(requestId: string, updates: Record<string, unknown>) {
  const allowedFields: Record<string, string> = {
    status: 'status',
    assigned_to: 'assigned_to',
    response_text: 'response_text',
    is_opened: 'is_opened',
    conseiller_note: 'conseiller_note',
    urgence_conseiller: 'urgence_conseiller',
    difficulty: 'difficulty',
    priority: 'priority',
    closing_date: 'closing_date',
    request_category: 'request_category',
    request_sub_category: 'request_sub_category',
    request_description: 'request_description',
  };

  const supabaseUpdates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const [key, col] of Object.entries(allowedFields)) {
    if (updates[key] !== undefined) {
      supabaseUpdates[col] = updates[key];
    }
  }

  if (updates.status === 'Closed' && !updates.closing_date) {
    supabaseUpdates.closing_date = new Date().toISOString();
  }

  const { data: existing } = await supabase
    .from('requests')
    .select('id, firebase_request_id, user_id')
    .or(`firebase_request_id.eq.${requestId},id.eq.${requestId}`)
    .limit(1)
    .maybeSingle();

  if (!existing) throw new Error('Request not found');

  const { data, error } = await supabase
    .from('requests')
    .update(supabaseUpdates)
    .eq('id', existing.id)
    .select()
    .single();

  if (error) throw new Error(`Supabase updateRequestAdmin error: ${error.message}`);

  const db = getFirestore();
  const firebaseRequestId = existing.firebase_request_id ?? requestId;
  if (existing.user_id && firebaseRequestId) {
    const firestoreUpdates: Record<string, unknown> = {};
    if (updates.status !== undefined) firestoreUpdates['Status'] = updates.status;
    if (updates.assigned_to !== undefined) firestoreUpdates['Assigned to'] = updates.assigned_to;
    if (updates.response_text !== undefined) firestoreUpdates['Response Text'] = updates.response_text;
    if (updates.is_opened !== undefined) firestoreUpdates['is_opened'] = updates.is_opened;
    if (updates.conseiller_note !== undefined) firestoreUpdates['Conseiller Note'] = updates.conseiller_note;
    if (updates.urgence_conseiller !== undefined) firestoreUpdates['Urgence Conseiller'] = updates.urgence_conseiller;
    if (updates.difficulty !== undefined) firestoreUpdates['Difficulty'] = updates.difficulty;
    if (updates.priority !== undefined) firestoreUpdates['Priority'] = updates.priority;
    if (updates.closing_date !== undefined) firestoreUpdates['Closing Date'] = updates.closing_date;

    if (Object.keys(firestoreUpdates).length > 0) {
      try {
        await db
          .collection('Clients').doc(existing.user_id)
          .collection('Requests').doc(firebaseRequestId)
          .update(firestoreUpdates);
      } catch (fsErr) {
        console.error('[adminCrm] Firestore sync failed for request update:', fsErr);
      }
    }
  }

  return formatRequestRow(data);
}

// ---------------------------------------------------------------------------
// Create Request (admin / conseiller)
// ---------------------------------------------------------------------------

export async function createRequestAdmin(payload: Record<string, unknown>, createdBy: string) {
  const now = new Date().toISOString();
  const userId = payload.user_id as string;

  let clientId: string | null = null;
  if (userId) {
    clientId = await resolveSupabaseClientId(userId);
  }

  const row: Record<string, any> = {
    user_id: userId,
    client_id: clientId,
    request_type: payload.request_type ?? 'Request',
    request_category: payload.request_category ?? '',
    request_sub_category: payload.request_sub_category ?? null,
    request_description: payload.request_description ?? '',
    status: payload.status ?? 'Assigned',
    assigned_to: payload.assigned_to ?? null,
    first_name: payload.first_name ?? '',
    last_name: payload.last_name ?? '',
    email: payload.email ?? '',
    membership_type: payload.membership_type ?? '',
    priority: payload.priority ?? null,
    difficulty: payload.difficulty ?? null,
    urgence_conseiller: payload.urgence_conseiller ?? '',
    source: 'CRM',
    platform: 'web',
    created_by: createdBy,
    is_rdv: payload.is_rdv ?? (payload.request_type === 'Rendez-vous'),
    request_date: payload.request_date ?? now,
    available_days: payload.available_days ?? [],
    available_hours: payload.available_hours ?? [],
    tags: payload.tags ?? [],
    created_at: now,
    updated_at: now,
  };

  const { data, error } = await supabase
    .from('requests')
    .insert(row)
    .select()
    .single();

  if (error) throw new Error(`Supabase createRequestAdmin error: ${error.message}`);

  if (userId) {
    const db = getFirestore();
    try {
      const firestoreData: Record<string, any> = {
        'Request Type': row.request_type,
        'Request Category': row.request_category,
        'Request Sub-Category': row.request_sub_category,
        'Description': row.request_description,
        'Status': row.status,
        'Assigned to': row.assigned_to,
        'First Name': row.first_name,
        'Last Name': row.last_name,
        'Email': row.email,
        'Membership Type': row.membership_type,
        'Priority': row.priority,
        'Difficulty': row.difficulty,
        'Request Date': new Date(row.request_date),
        'Created By': createdBy,
        'source': 'CRM',
        'platform': 'web',
        'is_rdv': row.is_rdv,
      };

      const docRef = await db
        .collection('Clients').doc(userId)
        .collection('Requests')
        .add(firestoreData);

      await supabase
        .from('requests')
        .update({ firebase_request_id: docRef.id })
        .eq('id', data.id);

      data.firebase_request_id = docRef.id;
    } catch (fsErr) {
      console.error('[adminCrm] Firestore sync failed for request create:', fsErr);
    }
  }

  return formatRequestRow(data);
}

// ---------------------------------------------------------------------------
// Client Requests (admin)
// ---------------------------------------------------------------------------

export async function getClientRequests(clientId: string, filters: Pick<RequestFilters, 'status' | 'page' | 'limit'>) {
  const pageLimit = Math.min(filters.limit ?? 50, 200);
  const page = filters.page ?? 1;
  const offset = (page - 1) * pageLimit;

  const { data: client } = await supabase
    .from('clients')
    .select('id, firebase_uid')
    .or(`id.eq.${clientId},firebase_uid.eq.${clientId}`)
    .limit(1)
    .maybeSingle();

  if (!client) throw new Error('Client not found');

  let query = supabase
    .from('requests')
    .select('*', { count: 'exact' })
    .or(`client_id.eq.${client.id},user_id.eq.${client.firebase_uid}`)
    .order('request_date', { ascending: false });

  if (filters.status) query = query.eq('status', filters.status);

  query = query.range(offset, offset + pageLimit - 1);
  const { data, error, count } = await query;
  if (error) throw new Error(`Supabase getClientRequests error: ${error.message}`);

  return {
    requests: (data ?? []).map(formatRequestRow),
    total: count ?? 0,
    page,
    limit: pageLimit,
  };
}

// ---------------------------------------------------------------------------
// Subscription Events by Client
// ---------------------------------------------------------------------------

export async function getClientSubscriptionEvents(clientId: string, limit = 100) {
  const { data: client } = await supabase
    .from('clients')
    .select('id')
    .or(`id.eq.${clientId},firebase_uid.eq.${clientId}`)
    .limit(1)
    .maybeSingle();

  if (!client) throw new Error('Client not found');

  const { data: subs } = await supabase
    .from('subscriptions')
    .select('id')
    .eq('client_id', client.id);

  const subIds = (subs ?? []).map(s => s.id);
  if (subIds.length === 0) return [];

  const { data, error } = await supabase
    .from('subscription_events')
    .select('*')
    .in('subscription_id', subIds)
    .order('occurred_at', { ascending: false })
    .limit(limit);

  if (error) throw new Error(`Supabase getClientSubscriptionEvents error: ${error.message}`);
  return data ?? [];
}

// ---------------------------------------------------------------------------
// Advanced Request Stats (dashboard)
// ---------------------------------------------------------------------------

export interface RequestStatsFilters {
  period?: 'today' | 'week' | 'month' | 'year' | 'custom';
  date_from?: string;
  date_to?: string;
  conseiller_name?: string;
}

export async function getRequestStats(filters: RequestStatsFilters) {
  const now = new Date();
  let dateFrom: Date;
  let dateTo = new Date();

  switch (filters.period) {
    case 'today':
      dateFrom = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      break;
    case 'week': {
      const dayOfWeek = now.getDay();
      dateFrom = new Date(now);
      dateFrom.setDate(now.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
      dateFrom.setHours(0, 0, 0, 0);
      break;
    }
    case 'year':
      dateFrom = new Date(now.getFullYear(), 0, 1);
      break;
    case 'custom':
      dateFrom = filters.date_from ? new Date(filters.date_from) : new Date(now.getTime() - 30 * 86400000);
      dateTo = filters.date_to ? new Date(filters.date_to) : new Date();
      break;
    case 'month':
    default:
      dateFrom = new Date(now.getFullYear(), now.getMonth(), 1);
      break;
  }

  const fromIso = dateFrom.toISOString();
  const toIso = dateTo.toISOString();

  let allQuery = supabase
    .from('requests')
    .select('status, request_category, source, assigned_to, request_date, is_rdv, created_by')
    .gte('request_date', fromIso)
    .lte('request_date', toIso)
    .limit(10000);

  if (filters.conseiller_name) {
    allQuery = allQuery.eq('assigned_to', filters.conseiller_name);
  }

  let closedQuery = supabase
    .from('requests')
    .select('closing_date')
    .eq('status', 'Closed')
    .gte('closing_date', fromIso)
    .lte('closing_date', toIso)
    .limit(10000);

  if (filters.conseiller_name) {
    closedQuery = closedQuery.eq('assigned_to', filters.conseiller_name);
  }

  const [allInPeriod, closedInPeriod] = await Promise.all([allQuery, closedQuery]);

  const rows = allInPeriod.data ?? [];

  const byStatus: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  const adviserMap: Record<string, Record<string, number>> = {};

  for (const r of rows) {
    const st = r.status ?? 'Unknown';
    byStatus[st] = (byStatus[st] || 0) + 1;

    const cat = r.request_category ?? 'Unknown';
    byCategory[cat] = (byCategory[cat] || 0) + 1;

    const src = r.source ?? 'Unknown';
    bySource[src] = (bySource[src] || 0) + 1;

    const adv = r.assigned_to ?? 'Non assigné';
    if (!adviserMap[adv]) adviserMap[adv] = {};
    adviserMap[adv][st] = (adviserMap[adv][st] || 0) + 1;
  }

  const byAdviser = Object.entries(adviserMap).map(([name, statuses]) => ({
    name,
    assigned: statuses['Assigned'] ?? 0,
    in_progress: statuses['In progress'] ?? 0,
    pending: statuses['Pending'] ?? 0,
    closed: statuses['Closed'] ?? 0,
    unsatisfied: statuses['Unsatisfied'] ?? 0,
    total: Object.values(statuses).reduce((a, b) => a + b, 0),
  }));

  const closedRows = closedInPeriod.data ?? [];
  const dailyClosed: Record<string, number> = {};
  for (const r of closedRows) {
    if (r.closing_date) {
      const day = r.closing_date.slice(0, 10);
      dailyClosed[day] = (dailyClosed[day] || 0) + 1;
    }
  }

  const dailyCreated: Record<string, number> = {};
  for (const r of rows) {
    if (r.request_date) {
      const day = typeof r.request_date === 'string' ? r.request_date.slice(0, 10) : '';
      if (day) dailyCreated[day] = (dailyCreated[day] || 0) + 1;
    }
  }

  const allDays = new Set([...Object.keys(dailyClosed), ...Object.keys(dailyCreated)]);
  const timeline = Array.from(allDays)
    .sort()
    .map(day => ({ date: day, created: dailyCreated[day] ?? 0, closed: dailyClosed[day] ?? 0 }));

  return {
    total: rows.length,
    byStatus,
    byCategory,
    bySource,
    byAdviser,
    timeline,
    period: { from: fromIso, to: toIso },
  };
}

// ---------------------------------------------------------------------------
// Conseillers
// ---------------------------------------------------------------------------

export async function listConseillers() {
  const { data, error } = await supabase
    .from('conseillers')
    .select('*')
    .order('name', { ascending: true });

  if (error) throw new Error(`Supabase listConseillers error: ${error.message}`);
  return (data ?? []).map(c => ({ id: c.firestore_id ?? c.id, ...c }));
}

export async function getConseillerById(conseillerId: string) {
  const { data, error } = await supabase
    .from('conseillers')
    .select('*')
    .or(`firestore_id.eq.${conseillerId},id.eq.${conseillerId}`)
    .single();

  if (error || !data) return null;
  return { id: data.firestore_id ?? data.id, ...data };
}

export async function updateConseiller(conseillerId: string, updates: Record<string, unknown>) {
  const db = getFirestore();
  await db.collection('Conseillers2').doc(conseillerId).update(updates);
  const doc = await db.collection('Conseillers2').doc(conseillerId).get();
  const data = doc.data() ?? {};
  dualWriteConseiller(conseillerId, data).catch(() => {});
  return { id: doc.id, ...data };
}

// ---------------------------------------------------------------------------
// Promotions (Supabase)
// ---------------------------------------------------------------------------

export async function listPromotions() {
  const { data, error } = await supabase
    .from('promotions')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) throw new Error(`Supabase listPromotions error: ${error.message}`);
  return data ?? [];
}

export async function createPromotion(payload: Record<string, unknown>) {
  const { data, error } = await supabase
    .from('promotions')
    .insert(payload)
    .select()
    .single();

  if (error) throw new Error(`Supabase createPromotion error: ${error.message}`);
  return data;
}

export async function updatePromotion(promoId: string, updates: Record<string, unknown>) {
  const { data, error } = await supabase
    .from('promotions')
    .update(updates)
    .eq('id', promoId)
    .select()
    .single();

  if (error) throw new Error(`Supabase updatePromotion error: ${error.message}`);
  return data;
}

export async function deletePromotion(promoId: string) {
  const { error } = await supabase
    .from('promotions')
    .delete()
    .eq('id', promoId);

  if (error) throw new Error(`Supabase deletePromotion error: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Advertisements (Supabase)
// ---------------------------------------------------------------------------

export async function listAdvertisements() {
  const { data, error } = await supabase
    .from('advertisements')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) throw new Error(`Supabase listAdvertisements error: ${error.message}`);
  return data ?? [];
}

export async function createAdvertisement(payload: Record<string, unknown>) {
  const { data, error } = await supabase
    .from('advertisements')
    .insert(payload)
    .select()
    .single();

  if (error) throw new Error(`Supabase createAdvertisement error: ${error.message}`);
  return data;
}

export async function updateAdvertisement(adId: string, updates: Record<string, unknown>) {
  const { data, error } = await supabase
    .from('advertisements')
    .update(updates)
    .eq('id', adId)
    .select()
    .single();

  if (error) throw new Error(`Supabase updateAdvertisement error: ${error.message}`);
  return data;
}

export async function deleteAdvertisement(adId: string) {
  const { error } = await supabase
    .from('advertisements')
    .delete()
    .eq('id', adId);

  if (error) throw new Error(`Supabase deleteAdvertisement error: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Tips (Supabase)
// ---------------------------------------------------------------------------

export async function listTips() {
  const { data, error } = await supabase
    .from('tips')
    .select(`*, tip_translations(*)`)
    .order('created_at', { ascending: false });

  if (error) throw new Error(`Supabase listTips error: ${error.message}`);
  return data ?? [];
}

export async function createTip(payload: { category?: string; is_active?: boolean; translations?: Record<string, { title: string; content: string }> }) {
  const { translations, ...tipData } = payload;

  const { data: tip, error } = await supabase
    .from('tips')
    .insert(tipData)
    .select()
    .single();

  if (error) throw new Error(`Supabase createTip error: ${error.message}`);

  if (translations && tip) {
    const rows = Object.entries(translations).map(([lang, t]) => ({
      tip_id: tip.id,
      language: lang,
      title: t.title,
      content: t.content,
    }));
    await supabase.from('tip_translations').insert(rows);
  }

  return tip;
}

export async function updateTip(tipId: string, updates: Record<string, unknown>) {
  const { translations, ...tipData } = updates as any;

  if (Object.keys(tipData).length > 0) {
    const { error } = await supabase.from('tips').update(tipData).eq('id', tipId);
    if (error) throw new Error(`Supabase updateTip error: ${error.message}`);
  }

  if (translations) {
    for (const [lang, t] of Object.entries(translations) as [string, any][]) {
      await supabase
        .from('tip_translations')
        .upsert({ tip_id: tipId, language: lang, title: t.title, content: t.content }, { onConflict: 'tip_id,language' });
    }
  }

  const { data } = await supabase.from('tips').select('*, tip_translations(*)').eq('id', tipId).single();
  return data;
}

export async function deleteTip(tipId: string) {
  await supabase.from('tip_translations').delete().eq('tip_id', tipId);
  const { error } = await supabase.from('tips').delete().eq('id', tipId);
  if (error) throw new Error(`Supabase deleteTip error: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Dashboard Stats (overview)
// ---------------------------------------------------------------------------

export async function getOverviewStats() {
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const [clientsResult, leadsResult, subResult, requestsCount, recentReqResult, conseillersResult] = await Promise.all([
    supabase.from('clients').select('id', { count: 'exact', head: true }),
    supabase.from('leads').select('id', { count: 'exact', head: true }).is('archived_at', null),
    supabase.from('subscriptions').select('id, membership_type, is_unpaid', { count: 'exact' }).eq('is_unpaid', false),
    supabase.from('requests').select('id', { count: 'exact', head: true }),
    supabase.from('requests')
      .select('id, firebase_request_id, user_id, request_date, status')
      .gte('request_date', thirtyDaysAgo.toISOString())
      .order('request_date', { ascending: true }),
    supabase.from('conseillers').select('id, firestore_id, name, firebase_uid'),
  ]);

  const recentRequests = (recentReqResult.data ?? []).map(r => ({
    id: r.firebase_request_id ?? r.id,
    clientId: r.user_id,
    created_at: r.request_date,
    status: r.status ?? 'Unknown',
  }));

  const advisers = (conseillersResult.data ?? []).map(c => ({
    id: c.firestore_id ?? c.id,
    name: c.name ?? '',
    firebase_uid: c.firebase_uid ?? c.firestore_id,
  }));

  return {
    totalClients: clientsResult.count ?? 0,
    totalRequests: requestsCount.count ?? 0,
    totalLeads: leadsResult.count ?? 0,
    activeSubscriptions: subResult.count ?? 0,
    subscriptionsByType: subResult.data?.reduce((acc: Record<string, number>, s: any) => {
      const mt = s.membership_type ?? 'unknown';
      acc[mt] = (acc[mt] || 0) + 1;
      return acc;
    }, {}) ?? {},
    recentRequests,
    advisers,
  };
}

export async function getSubscriptionStats() {
  const { data: events, error } = await supabase
    .from('subscription_events')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) throw new Error(`Supabase getSubscriptionStats error: ${error.message}`);

  const { data: activeSubs } = await supabase
    .from('subscriptions')
    .select('membership_type, status, plan_type')
    .eq('status', 'active');

  return {
    events: events ?? [],
    activeSubs: activeSubs ?? [],
  };
}

// ---------------------------------------------------------------------------
// Source Analysis
// ---------------------------------------------------------------------------

export async function getSourceAnalysis(dateFrom: string, dateTo: string) {
  const { data: rows } = await supabase
    .from('requests')
    .select('request_date, created_by')
    .gte('request_date', dateFrom)
    .lte('request_date', dateTo)
    .limit(10000);

  const dailyMap: Record<string, { crm: number; app: number }> = {};
  let totalCRM = 0;
  let totalAPP = 0;

  for (const r of (rows ?? [])) {
    const day = typeof r.request_date === 'string' ? r.request_date.slice(0, 10) : '';
    if (!day) continue;
    if (!dailyMap[day]) dailyMap[day] = { crm: 0, app: 0 };
    const src = (r.created_by ?? '').toUpperCase();
    if (src === 'CRM') {
      dailyMap[day].crm++;
      totalCRM++;
    } else {
      dailyMap[day].app++;
      totalAPP++;
    }
  }

  const data = Object.entries(dailyMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, counts]) => ({ date, ...counts }));

  return { data, totalCRM, totalAPP };
}

// ---------------------------------------------------------------------------
// Adviser Analysis
// ---------------------------------------------------------------------------

export async function getAdviserAnalysis(conseillerName: string | null, dateFrom: string, dateTo: string) {
  const { data: conseillers } = await supabase
    .from('conseillers')
    .select('id, firestore_id, name');

  let query = supabase
    .from('requests')
    .select('assigned_to, closing_date, difficulty, status')
    .eq('status', 'Closed')
    .gte('closing_date', dateFrom)
    .lte('closing_date', dateTo)
    .limit(10000);

  const { data: closedRows } = await query;

  const { data: allRows } = await supabase
    .from('requests')
    .select('assigned_to, status')
    .gte('request_date', dateFrom)
    .lte('request_date', dateTo)
    .limit(10000);

  const adviserSummary: Record<string, { assigned: number; inProgress: number; closed: number; total: number }> = {};
  for (const r of (allRows ?? [])) {
    const name = r.assigned_to ?? 'Non assigné';
    if (!adviserSummary[name]) adviserSummary[name] = { assigned: 0, inProgress: 0, closed: 0, total: 0 };
    adviserSummary[name].total++;
    if (r.status === 'Assigned') adviserSummary[name].assigned++;
    else if (r.status === 'In progress') adviserSummary[name].inProgress++;
    else if (r.status === 'Closed') adviserSummary[name].closed++;
  }

  const adviserStats = Object.entries(adviserSummary).map(([name, s]) => ({ name, ...s }));

  const dailyMap: Record<string, { closed: number; soug: number; soug_count: number }> = {};
  for (const r of (closedRows ?? [])) {
    if (conseillerName && r.assigned_to !== conseillerName) continue;
    const day = r.closing_date ? r.closing_date.slice(0, 10) : '';
    if (!day) continue;
    if (!dailyMap[day]) dailyMap[day] = { closed: 0, soug: 0, soug_count: 0 };
    dailyMap[day].closed++;
    const diff = Number(r.difficulty) || 0;
    if (diff > 0) {
      dailyMap[day].soug += diff;
      dailyMap[day].soug_count++;
    }
  }

  const dailyData = Object.entries(dailyMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, d]) => ({
      date,
      closed: d.closed,
      soug: d.soug_count > 0 ? Math.round((d.soug / d.soug_count) * 10) / 10 : 0,
    }));

  const totalClosed = dailyData.reduce((a, b) => a + b.closed, 0);
  const totalSoug = Object.values(dailyMap).reduce((a, b) => a + b.soug, 0);
  const totalSougCount = Object.values(dailyMap).reduce((a, b) => a + b.soug_count, 0);
  const avgSoug = totalSougCount > 0 ? Math.round((totalSoug / totalSougCount) * 10) / 10 : 0;
  const daysWorked = dailyData.filter(d => d.closed >= 5).length;

  return {
    dailyData,
    adviserStats,
    conseillers: (conseillers ?? []).map((c: any) => ({ id: c.firestore_id ?? c.id, name: c.name ?? '' })),
    summary: { totalClosed, avgSoug, daysWorked },
  };
}

// ---------------------------------------------------------------------------
// Membership Analysis
// ---------------------------------------------------------------------------

export async function getMembershipAnalysis(dateFrom: string, dateTo: string) {
  const { data: platformStats, error: psError } = await supabase
    .from('daily_platform_stats')
    .select('date, membership_distribution')
    .gte('date', dateFrom)
    .lte('date', dateTo)
    .order('date', { ascending: true })
    .limit(1000);

  if (!psError && platformStats && platformStats.length > 0) {
    const data = platformStats.map((row: any) => {
      const dist = row.membership_distribution ?? {};
      return {
        date: row.date,
        start: dist['Pack Start'] ?? dist['start'] ?? 0,
        essential: dist['Pack Essential'] ?? dist['essential'] ?? 0,
        vip: dist['Pack VIP'] ?? dist['vip'] ?? 0,
        elite: dist['Pack Elite'] ?? dist['elite'] ?? 0,
      };
    });
    return data;
  }

  const { data: subs } = await supabase
    .from('subscriptions')
    .select('membership_type')
    .eq('status', 'active');

  const counts: Record<string, number> = {};
  for (const s of (subs ?? [])) {
    const mt = (s.membership_type ?? 'unknown').toLowerCase();
    counts[mt] = (counts[mt] || 0) + 1;
  }

  return [{
    date: new Date().toISOString().slice(0, 10),
    start: counts['pack start'] ?? counts['start'] ?? 0,
    essential: counts['pack essential'] ?? counts['essential'] ?? 0,
    vip: counts['pack vip'] ?? counts['vip'] ?? 0,
    elite: counts['pack elite'] ?? counts['elite'] ?? 0,
  }];
}
