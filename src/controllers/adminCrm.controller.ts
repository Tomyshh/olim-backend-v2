import type { Response } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth.middleware.js';
import * as adminCrmService from '../services/adminCrm.service.js';
import { HttpError } from '../utils/errors.js';
import { supabase } from '../services/supabase.service.js';
import { getAuth } from '../config/firebase.js';
import {
  uploadDual,
  sanitizeFilename,
  inferContentType,
  deleteFromBoth,
} from '../services/storage.service.js';

function pickOptional(val: unknown): string | undefined {
  return typeof val === 'string' && val.trim() ? val.trim() : undefined;
}

function pickNumber(val: unknown, fallback: number): number {
  const n = Number(val);
  return Number.isFinite(n) ? n : fallback;
}

// ─── Clients ──────────────────────────────────────────────────────────

export async function listClients(req: AuthenticatedRequest, res: Response) {
  const q = req.query as Record<string, string>;
  const result = await adminCrmService.listClients({
    search: pickOptional(q.search),
    membership: pickOptional(q.membership),
    subscription_status: pickOptional(q.subscription_status),
    payment_status: pickOptional(q.payment_status),
    sort_by: pickOptional(q.sort_by),
    sort_order: q.sort_order === 'asc' ? 'asc' : 'desc',
    page: pickNumber(q.page, 1),
    limit: pickNumber(q.limit, 50),
  });
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.json(result);
}

export async function searchClientsLight(req: AuthenticatedRequest, res: Response) {
  const q = (req.query.q as string || '').trim();
  if (q.length < 2) { res.json([]); return; }
  const limit = Math.min(Number(req.query.limit) || 10, 30);
  try {
    const results = await adminCrmService.searchClientsLight(q, limit);
    res.json(results);
  } catch (err: any) {
    console.error('[searchClientsLight] error:', err.message);
    res.status(500).json({ message: err.message || 'Erreur recherche clients' });
  }
}

export async function getClient(req: AuthenticatedRequest, res: Response) {
  const { clientId } = req.params;
  const client = await adminCrmService.getClientById(clientId);
  if (!client) throw new HttpError(404, 'Client not found');
  res.json(client);
}

export async function updateClient(req: AuthenticatedRequest, res: Response) {
  const { clientId } = req.params;
  const existing = await adminCrmService.getClientById(clientId);
  if (!existing) throw new HttpError(404, 'Client not found');
  const updated = await adminCrmService.updateClient(clientId, req.body);
  res.json(updated);
}

export async function deleteClient(req: AuthenticatedRequest, res: Response) {
  const { clientId } = req.params;
  const existing = await adminCrmService.getClientById(clientId);
  if (!existing) throw new HttpError(404, 'Client not found');
  await adminCrmService.deleteClient(clientId);
  res.json({ message: 'Client soft-deleted' });
}

// ─── Requests (admin all-clients view) ────────────────────────────────

export async function listRequests(req: AuthenticatedRequest, res: Response) {
  const q = req.query as Record<string, string>;
  const result = await adminCrmService.listRequestsAdmin({
    status: pickOptional(q.status),
    request_type: pickOptional(q.request_type),
    category: pickOptional(q.category),
    assigned_to: pickOptional(q.assigned_to),
    urgency: pickOptional(q.urgency),
    search: pickOptional(q.search),
    date_from: pickOptional(q.date_from),
    date_to: pickOptional(q.date_to),
    unread_only: q.unread_only === 'true',
    page: pickNumber(q.page, 1),
    limit: pickNumber(q.limit, 50),
    sort_by: pickOptional(q.sort_by),
    sort_order: q.sort_order === 'asc' ? 'asc' : 'desc',
  });
  res.json(result);
}

export async function getRequest(req: AuthenticatedRequest, res: Response) {
  const request = await adminCrmService.getRequestById(req.params.requestId);
  if (!request) throw new HttpError(404, 'Request not found');
  res.json(request);
}

export async function updateRequest(req: AuthenticatedRequest, res: Response) {
  const existing = await adminCrmService.getRequestById(req.params.requestId);
  if (!existing) throw new HttpError(404, 'Request not found');
  const updated = await adminCrmService.updateRequestAdmin(req.params.requestId, req.body);
  res.json(updated);
}

export async function createRequest(req: AuthenticatedRequest, res: Response) {
  const createdBy = (req as any).user?.firebase_uid ?? (req as any).user?.uid ?? 'admin';
  const request = await adminCrmService.createRequestAdmin(req.body, createdBy);
  res.status(201).json(request);
}

// ─── Client Requests ──────────────────────────────────────────────────

export async function getClientRequests(req: AuthenticatedRequest, res: Response) {
  const q = req.query as Record<string, string>;
  const result = await adminCrmService.getClientRequests(req.params.clientId, {
    status: pickOptional(q.status),
    page: pickNumber(q.page, 1),
    limit: pickNumber(q.limit, 50),
  });
  res.json(result);
}

// ─── Client Subscription Events ───────────────────────────────────────

export async function getClientSubscriptionEvents(req: AuthenticatedRequest, res: Response) {
  const events = await adminCrmService.getClientSubscriptionEvents(
    req.params.clientId,
    pickNumber((req.query as any).limit, 100)
  );
  res.json(events);
}

// ─── Request Stats ────────────────────────────────────────────────────

export async function getRequestStats(req: AuthenticatedRequest, res: Response) {
  const q = req.query as Record<string, string>;
  const stats = await adminCrmService.getRequestStats({
    period: (q.period as any) ?? 'month',
    date_from: pickOptional(q.date_from),
    date_to: pickOptional(q.date_to),
    conseiller_name: pickOptional(q.conseiller_name),
  });
  res.json(stats);
}

export async function getSourceAnalysis(req: AuthenticatedRequest, res: Response) {
  const q = req.query as Record<string, string>;
  const now = new Date();
  const dateFrom = q.date_from || new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const dateTo = q.date_to || now.toISOString();
  const stats = await adminCrmService.getSourceAnalysis(dateFrom, dateTo);
  res.json(stats);
}

export async function getAdviserAnalysis(req: AuthenticatedRequest, res: Response) {
  const q = req.query as Record<string, string>;
  const now = new Date();
  const dateFrom = q.date_from || new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const dateTo = q.date_to || now.toISOString();
  const conseillerName = q.conseiller_name || null;
  const stats = await adminCrmService.getAdviserAnalysis(conseillerName, dateFrom, dateTo);
  res.json(stats);
}

export async function getMembershipAnalysis(req: AuthenticatedRequest, res: Response) {
  const q = req.query as Record<string, string>;
  const now = new Date();
  const dateFrom = q.date_from || new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const dateTo = q.date_to || now.toISOString();
  const stats = await adminCrmService.getMembershipAnalysis(dateFrom, dateTo);
  res.json(stats);
}

// ─── Conseillers ──────────────────────────────────────────────────────

export async function listConseillers(_req: AuthenticatedRequest, res: Response) {
  const conseillers = await adminCrmService.listConseillers();
  res.json(conseillers);
}

export async function getConseiller(req: AuthenticatedRequest, res: Response) {
  const c = await adminCrmService.getConseillerById(req.params.conseillerId);
  if (!c) throw new HttpError(404, 'Conseiller not found');
  res.json(c);
}

export async function updateConseiller(req: AuthenticatedRequest, res: Response) {
  const c = await adminCrmService.getConseillerById(req.params.conseillerId);
  if (!c) throw new HttpError(404, 'Conseiller not found');
  const updated = await adminCrmService.updateConseiller(req.params.conseillerId, req.body);
  res.json(updated);
}

// ─── Stats ────────────────────────────────────────────────────────────

export async function getOverviewStats(_req: AuthenticatedRequest, res: Response) {
  const stats = await adminCrmService.getOverviewStats();
  res.json(stats);
}

export async function getSubscriptionStats(_req: AuthenticatedRequest, res: Response) {
  const stats = await adminCrmService.getSubscriptionStats();
  res.json(stats);
}

// ─── Promotions ───────────────────────────────────────────────────────

export async function listPromotions(_req: AuthenticatedRequest, res: Response) {
  const promos = await adminCrmService.listPromotions();
  res.json(promos);
}

export async function createPromotion(req: AuthenticatedRequest, res: Response) {
  const promo = await adminCrmService.createPromotion(req.body);
  res.status(201).json(promo);
}

export async function updatePromotion(req: AuthenticatedRequest, res: Response) {
  const promo = await adminCrmService.updatePromotion(req.params.promoId, req.body);
  res.json(promo);
}

export async function deletePromotion(req: AuthenticatedRequest, res: Response) {
  await adminCrmService.deletePromotion(req.params.promoId);
  res.json({ message: 'Promotion deleted' });
}

// ─── Advertisements ───────────────────────────────────────────────────

export async function listAdvertisements(_req: AuthenticatedRequest, res: Response) {
  const ads = await adminCrmService.listAdvertisements();
  res.json(ads);
}

export async function createAdvertisement(req: AuthenticatedRequest, res: Response) {
  const ad = await adminCrmService.createAdvertisement(req.body);
  res.status(201).json(ad);
}

export async function updateAdvertisement(req: AuthenticatedRequest, res: Response) {
  const ad = await adminCrmService.updateAdvertisement(req.params.adId, req.body);
  res.json(ad);
}

export async function deleteAdvertisement(req: AuthenticatedRequest, res: Response) {
  await adminCrmService.deleteAdvertisement(req.params.adId);
  res.json({ message: 'Advertisement deleted' });
}

// ─── Tips ─────────────────────────────────────────────────────────────

export async function listTips(_req: AuthenticatedRequest, res: Response) {
  const tips = await adminCrmService.listTips();
  res.json(tips);
}

export async function createTip(req: AuthenticatedRequest, res: Response) {
  const tip = await adminCrmService.createTip(req.body);
  res.status(201).json(tip);
}

export async function updateTip(req: AuthenticatedRequest, res: Response) {
  const tip = await adminCrmService.updateTip(req.params.tipId, req.body);
  res.json(tip);
}

export async function deleteTip(req: AuthenticatedRequest, res: Response) {
  await adminCrmService.deleteTip(req.params.tipId);
  res.json({ message: 'Tip deleted' });
}

// ─── Client Documents (admin) ─────────────────────────────────────────

export async function uploadClientDocument(req: AuthenticatedRequest, res: Response) {
  const { clientId } = req.params;
  const documentType = String(req.body?.document_type || req.body?.type || '').trim();
  const forWho = String(req.body?.for_who || req.body?.forWho || '').trim();

  if (!documentType) throw new HttpError(400, 'document_type requis');

  const files = (req as any).files as Express.Multer.File[] | undefined;
  const file = files?.[0] || (req as any).file as Express.Multer.File | undefined;
  if (!file) throw new HttpError(400, 'Aucun fichier reçu');

  const { data: client } = await supabase
    .from('clients')
    .select('id, firebase_uid')
    .eq('id', clientId)
    .maybeSingle();
  if (!client) throw new HttpError(404, 'Client introuvable');

  const originalName = String(file.originalname || 'file');
  const clean = sanitizeFilename(originalName);
  const ts = Date.now();
  const contentType = inferContentType(originalName, file.mimetype);
  const typeSlug = documentType.toLowerCase().replace(/\s+/g, '_');
  const uidPath = client.firebase_uid || clientId;

  const result = await uploadDual({
    bucket: 'client-documents',
    firebasePath: `${uidPath}/documents/${typeSlug}/${ts}_${clean}`,
    supabasePath: `${uidPath}/${typeSlug}/${ts}_${clean}`,
    buffer: file.buffer,
    contentType,
    originalName,
    size: file.size || 0,
    uploaderId: req.uid || 'admin',
  });

  const now = new Date().toISOString();
  let docTypeId: string | null = null;
  try {
    const { data: dt } = await supabase
      .from('document_types')
      .select('id')
      .ilike('label', documentType.trim())
      .maybeSingle();
    docTypeId = dt?.id ?? null;
  } catch {}

  const row: Record<string, any> = {
    client_id: clientId,
    document_type: documentType,
    document_type_id: docTypeId,
    for_who: forWho || null,
    file_url: result.firebaseUrl,
    file_path: result.firebasePath,
    file_name: originalName,
    content_type: contentType,
    file_size: result.size,
    uploaded_at: now,
    supabase_storage_path: result.supabasePath,
    supabase_storage_bucket: result.supabaseBucket,
    metadata: {},
    created_at: now,
  };

  const { error: insertErr } = await supabase.from('client_documents').insert(row);
  if (insertErr) throw new HttpError(500, insertErr.message);

  res.status(201).json({
    message: 'Document ajouté',
    url: result.firebaseUrl,
    fileName: originalName,
  });
}

export async function deleteClientDocument(req: AuthenticatedRequest, res: Response) {
  const { clientId, documentId } = req.params;

  const { data: doc, error } = await supabase
    .from('client_documents')
    .select('*')
    .eq('client_id', clientId)
    .or(`id.eq.${documentId},firestore_id.eq.${documentId}`)
    .maybeSingle();

  if (error) throw new HttpError(500, error.message);
  if (!doc) throw new HttpError(404, 'Document introuvable');

  await deleteFromBoth(
    doc.supabase_storage_bucket || 'client-documents',
    doc.supabase_storage_path,
    doc.file_path,
  );

  const { error: delErr } = await supabase
    .from('client_documents')
    .delete()
    .eq('id', doc.id);
  if (delErr) throw new HttpError(500, delErr.message);

  res.json({ message: 'Document supprimé', documentId: doc.id });
}

// ─── Client Access (password / magic link) ────────────────────────────

export async function adminResetClientPassword(req: AuthenticatedRequest, res: Response) {
  const { clientId } = req.params;
  const newPassword = String(req.body?.newPassword || '');

  if (!newPassword || newPassword.length < 6) {
    throw new HttpError(400, 'Le mot de passe doit contenir au moins 6 caractères');
  }

  const { data: client } = await supabase
    .from('clients')
    .select('id, email, firebase_uid')
    .eq('id', clientId)
    .maybeSingle();
  if (!client) throw new HttpError(404, 'Client introuvable');

  const email = (client.email || '').toLowerCase().trim();

  // 1) Update Supabase Auth password
  try {
    const { data: listData } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
    const supabaseUser = listData?.users?.find(
      (u) => u.email?.toLowerCase() === email
    );
    if (supabaseUser) {
      const { error: updateError } = await supabase.auth.admin.updateUserById(
        supabaseUser.id,
        { password: newPassword }
      );
      if (updateError) console.error('[adminResetPassword] Supabase update error:', updateError.message);
    }
  } catch (err: any) {
    console.warn('[adminResetPassword] Supabase update skipped:', err.message);
  }

  // 2) Update Firebase Auth password
  try {
    const firebaseUser = client.firebase_uid
      ? await getAuth().getUser(client.firebase_uid)
      : await getAuth().getUserByEmail(email);
    await getAuth().updateUser(firebaseUser.uid, { password: newPassword });
  } catch (fbErr: any) {
    console.warn('[adminResetPassword] Firebase update skipped:', fbErr.message);
  }

  res.json({ ok: true, message: 'Mot de passe modifié avec succès' });
}

export async function adminSendMagicLink(req: AuthenticatedRequest, res: Response) {
  const { clientId } = req.params;

  const { data: client } = await supabase
    .from('clients')
    .select('id, email')
    .eq('id', clientId)
    .maybeSingle();
  if (!client) throw new HttpError(404, 'Client introuvable');

  const email = (client.email || '').toLowerCase().trim();
  if (!email) throw new HttpError(400, 'Le client n\'a pas d\'adresse email');

  const { error } = await supabase.auth.resetPasswordForEmail(email);
  if (error) throw new HttpError(400, error.message);

  res.json({ ok: true, message: `Email de réinitialisation envoyé à ${email}` });
}
