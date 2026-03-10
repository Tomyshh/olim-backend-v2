import type { NextFunction, Response } from 'express';
import type { AuthenticatedRequest } from './auth.middleware.js';
import { supabase } from '../services/supabase.service.js';
import { resolveSupabaseClientId } from '../services/dualWrite.service.js';

function normalizeMembership(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : '';
}

function isVisitorMembership(membership: string): boolean {
  const m = membership.trim().toLowerCase();
  return m === 'visitor' || m === 'visiteur';
}

export async function requireActiveMembershipForRequests(
  req: AuthenticatedRequest & { requestMembership?: string },
  res: Response,
  next: NextFunction
): Promise<void> {
  const uid = String(req.uid || '').trim();
  if (!uid) {
    res.status(401).json({ message: 'Vous devez être connecté.' });
    return;
  }

  const { data: client } = await supabase
    .from('clients')
    .select('id, free_access, metadata')
    .eq('firebase_uid', uid)
    .single();

  if (!client) {
    res.status(401).json({ message: 'Client introuvable.' });
    return;
  }

  const freeAccess = client.free_access as any;
  const freeEnabled = freeAccess?.isEnabled === true;
  const freeMembership = normalizeMembership(freeAccess?.membership);
  if (freeEnabled && freeMembership) {
    req.requestMembership = freeMembership;
    next();
    return;
  }

  const { data: sub } = await supabase
    .from('subscriptions')
    .select('membership_type, is_active, metadata')
    .eq('client_id', client.id)
    .single();

  const membership = normalizeMembership(sub?.membership_type);
  const isActive = sub?.is_active === true || (sub?.metadata as any)?.raw_states?.isActive === true;

  if (!membership || isVisitorMembership(membership) || !isActive) {
    res.status(403).json({
      message: "Vous ne pouvez pas envoyer de demande sans abonnement actif.",
      code: 'SUBSCRIPTION_REQUIRED'
    });
    return;
  }

  req.requestMembership = membership;
  next();
}

