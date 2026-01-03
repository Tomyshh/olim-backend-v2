import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { admin, getFirestore } from '../config/firebase.js';

// ⚠️ Toutes les routes admin sont stubées pour sécurité
// TODO: Ajouter middleware vérification rôle admin

const ALLOWED_REMOTE_CONFIG_KEYS = [
  'pack_start_mensually',
  'pack_essential_mensually',
  'pack_vip_mensually',
  'pack_elite_mensually',
  'pack_start_annually',
  'pack_essential_annually',
  'pack_vip_annually',
  'pack_elite_annually',
  'auth_provider_default',
  'add_family_member_ponctually',
  'add_family_member_mensually'
] as const;

type AllowedRemoteConfigKey = (typeof ALLOWED_REMOTE_CONFIG_KEYS)[number];

function getParamValue(template: any, key: string): string | null {
  const p = template?.parameters?.[key];
  const v = typeof p?.defaultValue?.value === 'string' ? p.defaultValue.value : null;
  if (v && v.trim()) return v.trim();

  // fallback: prendre la première conditionalValue non vide si la defaultValue n'existe pas
  const cond = p?.conditionalValues;
  if (cond && typeof cond === 'object') {
    for (const entry of Object.values(cond)) {
      const vv = typeof (entry as any)?.value === 'string' ? (entry as any).value : null;
      if (vv && vv.trim()) return vv.trim();
    }
  }
  return null;
}

function isStrictNonNegativeIntString(value: string): boolean {
  // "0" ou "123" (pas "-1", pas "01", pas "1.0", pas " 1 ")
  return /^(0|[1-9]\d*)$/.test(value);
}

function validateRemoteConfigParameters(payload: unknown): {
  ok: true;
  parameters: Record<AllowedRemoteConfigKey, string>;
  updatedKeys: AllowedRemoteConfigKey[];
} | { ok: false; status: number; message: string } {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, status: 400, message: 'Payload invalide: body JSON attendu.' };
  }
  const parameters = (payload as any).parameters;
  if (!parameters || typeof parameters !== 'object') {
    return { ok: false, status: 400, message: 'Payload invalide: champ "parameters" requis.' };
  }

  const allowed = new Set<string>(ALLOWED_REMOTE_CONFIG_KEYS as readonly string[]);
  const updatedKeys: AllowedRemoteConfigKey[] = [];
  const normalized: Record<string, string> = {};

  for (const [k, v] of Object.entries(parameters as Record<string, unknown>)) {
    if (!allowed.has(k)) {
      return { ok: false, status: 400, message: `Clé Remote Config non autorisée: ${k}` };
    }
    if (typeof v !== 'string') {
      return { ok: false, status: 400, message: `Valeur invalide pour ${k}: string requise.` };
    }
    const trimmed = v.trim();
    if (!trimmed) {
      return { ok: false, status: 400, message: `Valeur invalide pour ${k}: string non vide requise.` };
    }

    if (k === 'auth_provider_default') {
      if (trimmed !== 'mail' && trimmed !== 'phone') {
        return { ok: false, status: 400, message: 'auth_provider_default doit valoir "mail" ou "phone".' };
      }
    } else {
      if (!isStrictNonNegativeIntString(trimmed)) {
        return { ok: false, status: 400, message: `Valeur invalide pour ${k}: entier >= 0 en string stricte requis.` };
      }
    }

    normalized[k] = trimmed;
    updatedKeys.push(k as AllowedRemoteConfigKey);
  }

  return {
    ok: true,
    parameters: normalized as Record<AllowedRemoteConfigKey, string>,
    updatedKeys
  };
}

export async function getRemoteConfig(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const template = await admin.remoteConfig().getTemplate();
    const etag = (template as any)?.etag || null;

    const parameters: Record<string, string> = {};
    for (const key of ALLOWED_REMOTE_CONFIG_KEYS) {
      parameters[key] = getParamValue(template, key) ?? '';
    }

    res.status(200).json({
      success: true,
      etag,
      parameters
    });
  } catch (error: any) {
    console.error('Remote Config: unable to fetch template', { message: error?.message || String(error) });
    res.status(500).json({ success: false, message: 'Remote Config non accessible.' });
  }
}

export async function publishRemoteConfig(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const validation = validateRemoteConfigParameters(req.body);
    if (!validation.ok) {
      res.status(validation.status).json({ success: false, message: validation.message });
      return;
    }

    const template = await admin.remoteConfig().getTemplate();
    template.parameters = template.parameters || {};

    for (const key of validation.updatedKeys) {
      const currentParam = (template.parameters as any)[key] || {};
      (template.parameters as any)[key] = {
        ...currentParam,
        defaultValue: { value: validation.parameters[key] }
      };
    }

    const published = await admin.remoteConfig().publishTemplate(template);

    res.status(200).json({
      success: true,
      updatedKeys: validation.updatedKeys,
      etag: (published as any)?.etag || null
    });
  } catch (error: any) {
    console.error('Remote Config: unable to publish template', { message: error?.message || String(error) });
    res.status(500).json({ success: false, message: 'Publish Remote Config impossible.' });
  }
}

export async function getRefundRequests(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const db = getFirestore();
    const { status, limit = 100 } = req.query;

    let query = db.collection('RefundRequests').orderBy('createdAt', 'desc');

    if (status) {
      query = query.where('status', '==', status) as any;
    }

    const snapshot = await query.limit(Number(limit)).get();

    const refunds = snapshot.docs.map(doc => ({
      refundId: doc.id,
      ...doc.data()
    }));

    res.json({ refunds });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function updateRefundRequest(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { refundId } = req.params;
    const { status, processedAt } = req.body;
    const db = getFirestore();

    await db.collection('RefundRequests').doc(refundId).update({
      status,
      processedAt: processedAt || new Date(),
      updatedAt: new Date()
    });

    res.json({ message: 'Refund request updated', refundId, status });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function getSystemAlerts(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const db = getFirestore();
    const { active, limit = 50 } = req.query;

    let query = db.collection('SystemAlerts').orderBy('createdAt', 'desc');

    if (active === 'true') {
      query = query.where('active', '==', true) as any;
    }

    const snapshot = await query.limit(Number(limit)).get();

    const alerts = snapshot.docs.map(doc => ({
      alertId: doc.id,
      ...doc.data()
    }));

    res.json({ alerts });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function createSystemAlert(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { title, message, type, active = true } = req.body;
    const db = getFirestore();

    const alertRef = await db.collection('SystemAlerts').add({
      title,
      message,
      type: type || 'info',
      active,
      createdAt: new Date()
    });

    res.status(201).json({
      alertId: alertRef.id,
      title,
      message,
      type,
      active
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

// ⚠️ DÉSACTIVÉ - Sync Supabase (manuel)
export async function syncFirestoreToSupabaseManual(req: AuthenticatedRequest, res: Response): Promise<void> {
  res.status(501).json({
    message: 'Not implemented - syncFirestoreToSupabaseManual',
    note: 'Fonction désactivée pour sécurité. À implémenter avec Supabase client.'
  });
}

// ⚠️ DÉSACTIVÉ - Génération token FCM OAuth
export async function generateFCMAccessToken(req: AuthenticatedRequest, res: Response): Promise<void> {
  res.status(501).json({
    message: 'Not implemented - generateFCMAccessToken',
    note: 'Fonction désactivée pour sécurité. À implémenter avec OAuth2 pour FCM.'
  });
}

