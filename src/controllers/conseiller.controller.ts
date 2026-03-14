import type { Response } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { supabase } from '../services/supabase.service.js';

/**
 * GET /api/conseiller/me
 * Returns the current conseiller's profile including role.
 * Used by CRM frontend for role-based UI.
 */
export async function getMe(req: AuthenticatedRequest, res: Response) {
  const uid = req.uid;
  if (!uid) {
    res.status(401).json({ message: 'Non authentifié.' });
    return;
  }

  // Try all possible UID columns: id (Supabase UUID), firestore_id (legacy), firebase_uid
  const selectFields = `
    id,
    firestore_id,
    firebase_uid,
    name,
    email,
    is_admin,
    is_super_admin,
    role_id,
    roles (
      id,
      slug,
      label,
      has_leads_access
    )
  `;

  let data: any = null;

  // Lookup by id (Supabase UUID — primary for CRM auth)
  const byId = await supabase.from('conseillers').select(selectFields).eq('id', uid).maybeSingle();
  data = byId.data;

  // Fallback: firestore_id (legacy)
  if (!data) {
    const byFirestoreId = await supabase.from('conseillers').select(selectFields).eq('firestore_id', uid).maybeSingle();
    data = byFirestoreId.data;
  }

  // Fallback: firebase_uid
  if (!data) {
    const byFirebaseUid = await supabase.from('conseillers').select(selectFields).eq('firebase_uid', uid).maybeSingle();
    data = byFirebaseUid.data;
  }

  // Fallback: email from the auth token
  if (!data && req.user?.email) {
    const byEmail = await supabase.from('conseillers').select(selectFields).eq('email', req.user.email.toLowerCase()).maybeSingle();
    data = byEmail.data;
  }

  if (!data) {
    console.error(`[conseiller/me] Not found: uid=${uid}, email=${req.user?.email}`);
    res.status(403).json({ message: "Accès refusé : vous n'êtes pas conseiller." });
    return;
  }

  const role = data.roles as any;
  const roleSlug = role?.slug ?? (data.is_super_admin ? 'direction' : data.is_admin ? 'direction' : 'advisor');
  const roleLabel = role?.label ?? 'Conseiller';

  res.json({
    id: data.firestore_id ?? data.id,
    name: data.name,
    email: data.email,
    is_admin: data.is_admin === true,
    is_super_admin: data.is_super_admin === true,
    role_id: data.role_id,
    role_slug: roleSlug,
    role_label: roleLabel,
    has_leads_access: role?.has_leads_access === true,
  });
}
