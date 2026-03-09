import { supabase } from './supabase.service.js';
import { getFirestore } from '../config/firebase.js';

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

  let query = supabase
    .from('clients')
    .select(`
      *,
      subscriptions(id, plan_type, membership_type, status, price_cents, currency, payme_subscription_id, created_at, updated_at),
      family_members(id, first_name, last_name, status),
      client_addresses(id, label, address1, city, country, is_primary)
    `, { count: 'exact' });

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

  const { data, count, error } = await query;
  if (error) throw new Error(`Supabase listClients error: ${error.message}`);

  return { clients: data ?? [], total: count ?? 0, page, limit };
}

export async function getClientById(clientId: string) {
  const { data, error } = await supabase
    .from('clients')
    .select(`
      *,
      subscriptions(*),
      family_members(*),
      client_addresses(*),
      payment_credentials(id, card_name, last4, brand, is_subscription_card, created_at),
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
      payment_credentials(id, card_name, last4, brand, is_subscription_card, created_at),
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
  const page = filters.page ?? 1;
  const limit = Math.min(filters.limit ?? 50, 200);
  const offset = (page - 1) * limit;

  const db = getFirestore();
  let query: FirebaseFirestore.Query = db.collectionGroup('Requests');

  if (filters.status) query = query.where('Status', '==', filters.status);
  if (filters.request_type) query = query.where('Request Type', '==', filters.request_type);
  if (filters.category) query = query.where('Request Category', '==', filters.category);
  if (filters.assigned_to) query = query.where('assigned_to', '==', filters.assigned_to);
  if (filters.urgency) query = query.where('urgency', '==', filters.urgency);

  query = query.orderBy('Request Date', 'desc').limit(limit).offset(offset);

  const snapshot = await query.get();
  const requests = snapshot.docs.map(doc => ({
    id: doc.id,
    clientId: doc.ref.parent.parent?.id,
    ...doc.data(),
  }));

  return { requests, page, limit };
}

// ---------------------------------------------------------------------------
// Conseillers
// ---------------------------------------------------------------------------

export async function listConseillers() {
  const db = getFirestore();
  const snapshot = await db.collection('Conseillers2').get();

  return snapshot.docs.map(doc => ({
    id: doc.id,
    ...doc.data(),
  }));
}

export async function getConseillerById(conseillerId: string) {
  const db = getFirestore();
  const doc = await db.collection('Conseillers2').doc(conseillerId).get();
  if (!doc.exists) return null;
  return { id: doc.id, ...doc.data() };
}

export async function updateConseiller(conseillerId: string, updates: Record<string, unknown>) {
  const db = getFirestore();
  await db.collection('Conseillers2').doc(conseillerId).update(updates);
  const doc = await db.collection('Conseillers2').doc(conseillerId).get();
  return { id: doc.id, ...doc.data() };
}

// ---------------------------------------------------------------------------
// Promotions (Supabase)
// ---------------------------------------------------------------------------

export async function listPromotions() {
  const { data, error } = await supabase
    .from('promo_codes')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) throw new Error(`Supabase listPromotions error: ${error.message}`);
  return data ?? [];
}

export async function createPromotion(payload: Record<string, unknown>) {
  const { data, error } = await supabase
    .from('promo_codes')
    .insert(payload)
    .select()
    .single();

  if (error) throw new Error(`Supabase createPromotion error: ${error.message}`);
  return data;
}

export async function updatePromotion(promoId: string, updates: Record<string, unknown>) {
  const { data, error } = await supabase
    .from('promo_codes')
    .update(updates)
    .eq('id', promoId)
    .select()
    .single();

  if (error) throw new Error(`Supabase updatePromotion error: ${error.message}`);
  return data;
}

export async function deletePromotion(promoId: string) {
  const { error } = await supabase
    .from('promo_codes')
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
  const [clientsResult, requestsResult, leadsResult, subResult] = await Promise.all([
    supabase.from('clients').select('id', { count: 'exact', head: true }),
    supabase.from('requests').select('id', { count: 'exact', head: true }),
    supabase.from('leads').select('id', { count: 'exact', head: true }).eq('archived', false),
    supabase.from('subscriptions').select('id, status, membership_type', { count: 'exact' }).eq('status', 'active'),
  ]);

  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const { data: recentRequests } = await supabase
    .from('requests')
    .select('id, created_at, status')
    .gte('created_at', thirtyDaysAgo)
    .order('created_at', { ascending: true });

  const { data: advisers } = await supabase
    .from('conseillers')
    .select('id, name, firebase_uid');

  return {
    totalClients: clientsResult.count ?? 0,
    totalRequests: requestsResult.count ?? 0,
    totalLeads: leadsResult.count ?? 0,
    activeSubscriptions: subResult.count ?? 0,
    subscriptionsByType: subResult.data?.reduce((acc: Record<string, number>, s: any) => {
      acc[s.membership_type] = (acc[s.membership_type] || 0) + 1;
      return acc;
    }, {}) ?? {},
    recentRequests: recentRequests ?? [],
    advisers: advisers ?? [],
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
