import type { Response } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth.middleware.js';
import * as adminCrmService from '../services/adminCrm.service.js';
import { HttpError } from '../utils/errors.js';

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
  });
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
