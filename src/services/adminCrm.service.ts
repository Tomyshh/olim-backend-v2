import { supabase } from './supabase.service.js';
import { getFirestore } from '../config/firebase.js';
import { dualWriteConseiller } from './dualWrite.service.js';

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

  let query = supabase
    .from('requests')
    .select('*', { count: 'exact' })
    .order('request_date', { ascending: false });

  if (filters.status) query = query.eq('status', filters.status);
  if (filters.request_type) query = query.eq('request_type', filters.request_type);
  if (filters.category) query = query.eq('request_category', filters.category);
  if (filters.assigned_to) query = query.eq('assigned_to', filters.assigned_to);
  if (filters.search) {
    query = query.or(`request_description.ilike.%${filters.search}%,user_id.ilike.%${filters.search}%,assigned_to.ilike.%${filters.search}%`);
  }

  query = query.range(offset, offset + pageLimit - 1);
  const { data, error, count } = await query;
  if (error) throw new Error(`Supabase listRequestsAdmin error: ${error.message}`);

  const requests = (data ?? []).map(r => ({
    id: r.firebase_request_id ?? r.id,
    clientId: r.user_id,
    status: r.status ?? '',
    requestType: r.request_type ?? '',
    requestCategory: r.request_category ?? '',
    assignedTo: r.assigned_to ?? '',
    assignedToUid: r.assigned_to ?? null,
    description: r.request_description ?? '',
    requestDate: r.request_date,
    isOpened: r.is_opened ?? false,
    ...r,
  }));

  return { requests, total: count ?? 0, page, limit: pageLimit };
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
