import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { admin, getAuth, getFirestore } from '../config/firebase.js';
import { dualWriteToSupabase } from '../services/dualWrite.service.js';
import { spawn } from 'child_process';

// ⚠️ Toutes les routes admin sont stubées pour sécurité
// TODO: Ajouter middleware vérification rôle admin

const ALLOWED_REMOTE_CONFIG_KEYS = [
  'pack_start_mensually',
  'pack_essential_mensually',
  'pack_vip_mensually',
  // Typo historique côté app (à supporter)
  'pack_elite_mensualy',
  // Variante "corrigée" (historique backend)
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

    dualWriteToSupabase('refund_requests', {
      status,
      processed_at: (processedAt || new Date()).toISOString ? (processedAt || new Date()).toISOString() : new Date(processedAt || Date.now()).toISOString(),
      updated_at: new Date().toISOString()
    }, { mode: 'update', matchColumn: 'firestore_id', matchValue: refundId }).catch(() => {});

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

    const alertData = {
      title,
      message,
      type: type || 'info',
      active,
      createdAt: new Date()
    };
    const alertRef = await db.collection('SystemAlerts').add(alertData);

    dualWriteToSupabase('system_alerts', {
      firestore_id: alertRef.id,
      title,
      message,
      alert_type: type || 'info',
      is_active: active,
      created_at: new Date().toISOString()
    }, { mode: 'insert' }).catch(() => {});

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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Admin: crée un utilisateur Firebase Auth avec UID imposé.
 * Endpoint: POST /api/admin/firebase-auth/users
 * Body: { email, password, uid }
 */
export async function createFirebaseAuthUser(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { email, password, uid } = (req.body || {}) as {
      email?: unknown;
      password?: unknown;
      uid?: unknown;
    };

    if (!isNonEmptyString(email) || !isNonEmptyString(password) || !isNonEmptyString(uid)) {
      res.status(400).json({ message: 'invalid-argument: email/password/uid manquants ou invalides' });
      return;
    }

    const normalizedEmail = email.trim().toLowerCase();
    const normalizedUid = uid.trim();

    // Validation minimale (Firebase refera ses propres checks)
    if (normalizedUid.length > 128) {
      res.status(400).json({ message: 'invalid-argument: uid trop long (max 128)' });
      return;
    }

    const auth = getAuth();
    const user = await auth.createUser({
      uid: normalizedUid,
      email: normalizedEmail,
      password: password
    });

    res.status(200).json({ uid: user.uid, email: user.email || normalizedEmail });
  } catch (error: any) {
    const code = String(error?.code || '');

    // Conflits attendus
    if (code === 'auth/email-already-exists') {
      res.status(409).json({ message: 'email-already-exists' });
      return;
    }
    if (code === 'auth/uid-already-exists') {
      res.status(409).json({ message: 'uid-already-exists' });
      return;
    }

    // Erreurs de validation Firebase
    if (
      code === 'auth/invalid-email' ||
      code === 'auth/invalid-password' ||
      code === 'auth/invalid-uid' ||
      code === 'auth/argument-error'
    ) {
      res.status(400).json({ message: 'invalid-argument: email/password/uid manquants ou invalides' });
      return;
    }

    console.error('Firebase Auth: createUser failed', { code, message: error?.message || String(error) });
    res.status(500).json({ message: 'internal' });
  }
}

// ⚠️ DÉSACTIVÉ - Sync Supabase (manuel)
export async function syncFirestoreToSupabaseManual(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const body = (req.body || {}) as {
      uid?: string;
      all?: boolean;
      dryRun?: boolean;
      batchSize?: number;
    };

    const uid = typeof body.uid === 'string' ? body.uid.trim() : '';
    const all = body.all === true;
    const dryRun = body.dryRun !== false;
    const batchSize = Number(body.batchSize || 100);

    if (!uid && !all) {
      res.status(400).json({
        message: 'uid ou all=true requis',
        example: { uid: 'firebase_uid' },
        exampleAll: { all: true, dryRun: true, batchSize: 100 }
      });
      return;
    }
    if (uid && all) {
      res.status(400).json({ message: 'Choisir soit uid, soit all=true (pas les deux).' });
      return;
    }

    const args = ['tsx', 'scripts/migrate-client-to-supabase.ts'];
    if (uid) args.push('--uid', uid);
    if (all) args.push('--all', '--batch-size', String(Number.isFinite(batchSize) ? batchSize : 100));
    if (dryRun) args.push('--dry-run');

    const proc = spawn('npx', args, {
      cwd: process.cwd(),
      env: process.env
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('close', (code) => {
      const payload = {
        success: code === 0,
        mode: uid ? 'single' : 'all',
        uid: uid || null,
        dryRun,
        batchSize: all ? batchSize : null,
        exitCode: code,
        output: stdout.slice(-12000),
        errors: stderr.slice(-8000)
      };
      if (code === 0) {
        res.status(200).json(payload);
      } else {
        res.status(500).json(payload);
      }
    });
  } catch (error: any) {
    res.status(500).json({ message: error?.message || 'sync-firestore-to-supabase failed' });
  }
}

// ⚠️ DÉSACTIVÉ - Génération token FCM OAuth
export async function generateFCMAccessToken(req: AuthenticatedRequest, res: Response): Promise<void> {
  res.status(501).json({
    message: 'Not implemented - generateFCMAccessToken',
    note: 'Fonction désactivée pour sécurité. À implémenter avec OAuth2 pour FCM.'
  });
}

