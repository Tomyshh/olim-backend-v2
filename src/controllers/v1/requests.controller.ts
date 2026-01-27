import type { Response } from 'express';
import type { AuthenticatedRequest } from '../../middleware/auth.middleware.js';
import { getFirestore, admin } from '../../config/firebase.js';
import { supabase } from '../../services/supabase.service.js';
import { calculateAdjustedProcessTime } from '../../utils/processTime.js';

type RequestSource = 'APP' | 'VOICE' | 'SHARE' | 'SYSTEM';
type MembershipType = 'Pack Start' | 'Pack Essential' | 'Pack VIP' | 'Pack Elite' | 'Visitor' | string;

function isRecord(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === 'object' && !Array.isArray(x);
}

function normalizeSource(raw: unknown): RequestSource | null {
  const s = String(raw ?? '').trim().toUpperCase();
  if (s === 'APP' || s === 'VOICE' || s === 'SHARE' || s === 'SYSTEM') return s;
  return null;
}

function normalizeIdempotencyKey(raw: unknown): string {
  return String(raw ?? '').trim().slice(0, 128);
}

function looksLikeIsoDate(s: string): boolean {
  // Heuristique: ISO8601 avec 'T' + 'Z' ou offset
  // ex: 2026-01-26T05:49:28.811Z
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(s);
}

function shouldTreatKeyAsDate(key: string): boolean {
  const k = key.toLowerCase();
  return k.endsWith('at') || k.includes('date') || k.includes('timestamp');
}

function deepConvertIsoDatesToTimestamps(input: unknown, depth = 0, maxDepth = 20): unknown {
  if (depth >= maxDepth) return input;
  if (input === null || input === undefined) return input;
  if (typeof input === 'string') {
    if (looksLikeIsoDate(input)) {
      const d = new Date(input);
      if (!Number.isNaN(d.getTime())) {
        return admin.firestore.Timestamp.fromDate(d);
      }
    }
    return input;
  }
  if (Array.isArray(input)) return input.map((x) => deepConvertIsoDatesToTimestamps(x, depth + 1, maxDepth));
  if (typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (typeof v === 'string' && shouldTreatKeyAsDate(k) && looksLikeIsoDate(v)) {
        const d = new Date(v);
        out[k] = Number.isNaN(d.getTime()) ? v : admin.firestore.Timestamp.fromDate(d);
      } else {
        out[k] = deepConvertIsoDatesToTimestamps(v, depth + 1, maxDepth);
      }
    }
    return out;
  }
  return input;
}

function pickLegacyField(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    if (k in obj) return obj[k];
  }
  return undefined;
}

function normalizePriority(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.max(0, Math.floor(raw));
  const s = String(raw).trim().toLowerCase();
  const n = Number(s);
  if (Number.isFinite(n)) return Math.max(0, Math.floor(n));
  if (s === 'low' || s === 'faible') return 0;
  if (s === 'normal' || s === 'medium' || s === 'moyen') return 1;
  if (s === 'high' || s === 'urgent' || s === 'élevé' || s === 'eleve') return 2;
  return null;
}

function normalizeStringArray(raw: unknown): string[] | null {
  if (raw === null || raw === undefined) return null;
  if (Array.isArray(raw)) return raw.map((x) => String(x ?? '').trim()).filter(Boolean);
  return null;
}

function normalizeBoolean(raw: unknown): boolean | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'boolean') return raw;
  const s = String(raw).trim().toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes') return true;
  if (s === 'false' || s === '0' || s === 'no') return false;
  return null;
}

function normalizeInt(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.trunc(raw);
  const n = Number(String(raw).trim());
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function computePriority(params: { requestType: string; requestCategory: string; membership: MembershipType | null }): number {
  const { requestType, requestCategory, membership } = params;
  const rt = requestType.trim().toLowerCase();
  const rc = requestCategory.trim().toLowerCase();

  // Règles prioritaires (exigence)
  const highCats = new Set(['verifier facture paiement', 'payer en ligne', 'traduction']);
  if (rt === 'rendez-vous' || highCats.has(rc)) return 3;

  const m = String(membership ?? '').toLowerCase();
  if (m.includes('essential')) return 2;
  if (m.includes('vip')) return 4;
  if (m.includes('elite')) return 4;
  // Start + default
  return 1;
}

function calculateAdjustedWaitingTime(waitingTime: string | null, membership: MembershipType | null): string | null {
  if (!waitingTime) return null;
  const base = String(waitingTime).trim();
  if (!base) return null;
  return calculateAdjustedProcessTime(base, membership);
}

async function resolveAssignedTo(params: { uid: string; requestType: string; requestCategory: string; clientLanguage: string | null }): Promise<string> {
  const { uid, requestType, requestCategory, clientLanguage } = params;
  const rt = requestType.trim().toLowerCase();
  const rc = requestCategory.trim();

  // Règles "Internal System"
  if (rt === 'internal system') {
    if (rc === 'Vérifier remboursement') return 'Yaacov';
    return 'Odelia';
  }

  const db = getFirestore();
  const lang = String(clientLanguage || '').trim().toLowerCase() || 'fr';

  // On tente de choisir un conseiller présent, compatible langue, avec la charge la plus basse (now_request)
  try {
    const q = db
      .collection('Conseillers2')
      .where('isPresent', '==', true)
      .where(`language.${lang}`, '==', true)
      .orderBy('now_request', 'asc')
      .limit(1);
    const snap = await q.get();
    if (!snap.empty) {
      const d = snap.docs[0]!.data() as any;
      const name = String(d?.name || '').trim();
      if (name) return name;
    }
  } catch {
    // Index/field absent => fallback
  }

  try {
    const q2 = db.collection('Conseillers2').where('isPresent', '==', true).orderBy('now_request', 'asc').limit(1);
    const snap2 = await q2.get();
    if (!snap2.empty) {
      const d = snap2.docs[0]!.data() as any;
      const name = String(d?.name || '').trim();
      if (name) return name;
    }
  } catch {
    // ignore
  }

  // Fallback ultime demandé
  void uid;
  return 'Marie';
}

async function getClientContext(uid: string): Promise<{ language: string | null; membership: MembershipType | null; profile: Record<string, unknown> }> {
  const db = getFirestore();
  const snap = await db.collection('Clients').doc(uid).get();
  const profile = (snap.data() as Record<string, unknown>) || {};
  const language = (typeof profile.language === 'string' ? profile.language : null) || null;

  // membership: freeAccess > membership (new) > Membership (legacy)
  const freeAccess = isRecord(profile.freeAccess) ? profile.freeAccess : null;
  const freeMembership = freeAccess && typeof freeAccess.membership === 'string' ? freeAccess.membership : null;
  if (freeAccess && freeAccess.isEnabled === true && freeMembership) {
    return { language, membership: freeMembership, profile };
  }

  const membershipObj = isRecord(profile.membership) ? profile.membership : null;
  const membershipType = membershipObj && typeof membershipObj.type === 'string' ? membershipObj.type : null;
  if (membershipType) return { language, membership: membershipType, profile };

  const legacy = typeof (profile as any).Membership === 'string' ? String((profile as any).Membership) : null;
  return { language, membership: legacy, profile };
}

async function upsertSupabaseRequest(params: {
  uid: string;
  requestId: string;
  source: RequestSource;
  idempotencyKey: string;
  request: Record<string, unknown>;
  computed: { assignedTo: string; priority: number; waitingTime: string | null };
}): Promise<{ inserted: boolean; id: string | null }> {
  const { uid, requestId, source, idempotencyKey, request } = params;

  const requestType = String(pickLegacyField(request, ['Request Type', 'request_type', 'requestType']) ?? '').trim();
  const requestCategory = String(pickLegacyField(request, ['Request Category', 'request_category', 'category']) ?? '').trim();
  const requestSubCategory = String(pickLegacyField(request, ['Request Sub-Category', 'request_sub_category', 'subCategory']) ?? '').trim();
  const requestRef = String(pickLegacyField(request, ['Request Ref', 'request_ref']) ?? '').trim() || null;
  const description = String(pickLegacyField(request, ['Description', 'request_description', 'description']) ?? '').trim();
  const status = 'Assigned';
  const assignedTo = params.computed.assignedTo;
  const categoryId = String(pickLegacyField(request, ['Category ID', 'category_id']) ?? '').trim() || null;
  const subCategoryId = String(pickLegacyField(request, ['SubCategory ID', 'sub_category_id']) ?? '').trim() || null;

  const priority = params.computed.priority;

  const firstName = String(pickLegacyField(request, ['First Name', 'first_name']) ?? '').trim() || null;
  const lastName = String(pickLegacyField(request, ['Last Name', 'last_name']) ?? '').trim() || null;
  const email = String(pickLegacyField(request, ['Email', 'email']) ?? '').trim() || null;
  const phone = String(pickLegacyField(request, ['Phone', 'phone', 'Phone Number']) ?? '').trim() || null;
  const membershipType = String(pickLegacyField(request, ['membership_type', 'Membership Type', 'Membership']) ?? '').trim() || null;

  const uniqueId = `${source}-${requestId}-${uid.slice(0, 8)}`;

  const uploadedFiles = normalizeStringArray(pickLegacyField(request, ['Uploaded Files', 'uploaded_files'])) || [];
  const availableDays = normalizeStringArray(pickLegacyField(request, ['Available Days', 'available_days'])) || [];
  const availableHours = normalizeStringArray(pickLegacyField(request, ['Available Hours', 'available_hours'])) || [];
  const tags = normalizeStringArray(pickLegacyField(request, ['Tags', 'tags'])) || [];
  const ratingTags = normalizeStringArray(pickLegacyField(request, ['Rating Tags', 'rating_tags'])) || [];

  const difficulty = normalizeInt(pickLegacyField(request, ['Difficulty', 'difficulty'])) ?? 1;
  const rating = normalizeInt(pickLegacyField(request, ['Rating', 'rating']));
  const clientComment = (pickLegacyField(request, ['Client comment', 'client_comment']) ?? null) as any;

  const rdvLocation = String(pickLegacyField(request, ['Lieux du rdv', 'rdv_location', 'Location', 'Request_Location']) ?? '').trim() || null;
  const rdvDate = String(pickLegacyField(request, ['Date de rdv', 'rdv_date']) ?? '').trim() || null;
  const rdvHours = String(pickLegacyField(request, ['Heure du rdv', 'rdv_hours']) ?? '').trim() || null;
  const isRdv = String(requestType).toLowerCase() === 'rendez-vous' || normalizeBoolean(pickLegacyField(request, ['is_rdv', 'isRdv'])) === true;

  const responseText = String(pickLegacyField(request, ['Support Response', 'response_text']) ?? '').trim() || null;
  const responseFiles = normalizeStringArray(pickLegacyField(request, ['[Response] Attached Files', 'response_files'])) || [];

  // Request date: côté Supabase on met "now" (serveur) pour cohérence
  const requestDate = new Date().toISOString();

  const payload: Record<string, unknown> = {
    firebase_request_id: requestId,
    unique_id: uniqueId,
    user_id: uid,
    request_type: requestType || 'unknown',
    request_category: requestCategory || 'unknown',
    request_sub_category: requestSubCategory || null,
    request_ref: requestRef,
    request_description: description || null,
    uploaded_files: uploadedFiles,
    available_days: availableDays,
    available_hours: availableHours,
    tags,
    status,
    priority,
    difficulty,
    assigned_to: assignedTo,
    waiting_time: params.computed.waitingTime,
    category_id: categoryId,
    sub_category_id: subCategoryId,
    first_name: firstName,
    last_name: lastName,
    email,
    phone,
    membership_type: membershipType,
    is_rdv: isRdv,
    rdv_location: rdvLocation,
    rdv_date: rdvDate,
    rdv_hours: rdvHours,
    response_text: responseText,
    response_files: responseFiles,
    rating,
    rating_tags: ratingTags,
    client_comment: clientComment ?? null,
    source,
    platform: String(pickLegacyField(request, ['Platform', 'platform']) ?? 'mobile'),
    app_version: String(pickLegacyField(request, ['Version', 'app_version']) ?? '2.0'),
    created_by: source,
    request_date: requestDate,
    sync_source: 'backend',
    sync_date: new Date().toISOString(),
    metadata: {
      idempotencyKey,
      source,
      raw: request
    }
  };

  // Nettoyage: Supabase refuse parfois les champs undefined
  for (const k of Object.keys(payload)) {
    if (payload[k] === undefined) delete payload[k];
  }

  const { data, error } = await supabase.from('requests').upsert(payload as any, { onConflict: 'unique_id' }).select('id').maybeSingle();
  if (error) {
    // Ne pas bloquer la création Firestore si Supabase est en panne,
    // mais logguer: le fallback Firestore côté app dépend de la prod.
    console.error('[v1/requests] Supabase upsert failed', {
      uid,
      requestId,
      uniqueId,
      message: error.message,
      details: (error as any).details
    });
    return { inserted: false, id: null };
  }
  return { inserted: true, id: (data as any)?.id ? String((data as any).id) : null };
}

export async function v1CreateRequest(req: AuthenticatedRequest, res: Response): Promise<void> {
  const uid = String(req.uid || '').trim();
  if (!uid) {
    res.status(401).json({ message: 'Vous devez être connecté.' });
    return;
  }

  const body = req.body as unknown;
  if (!isRecord(body)) {
    res.status(400).json({ message: 'Body invalide.' });
    return;
  }

  const source = normalizeSource(body.source);
  if (!source) {
    res.status(400).json({ message: 'source invalide (APP|VOICE|SHARE|SYSTEM).' });
    return;
  }

  const idempotencyKey = normalizeIdempotencyKey(body.idempotencyKey);
  if (!idempotencyKey) {
    res.status(400).json({ message: 'idempotencyKey manquant.' });
    return;
  }

  const requestRaw = body.request;
  if (!isRecord(requestRaw)) {
    res.status(400).json({ message: 'request manquant ou invalide.' });
    return;
  }

  const db = getFirestore();
  const clientCtx = await getClientContext(uid);

  // Idempotency robuste même si Redis est absent:
  // on stocke une "clé -> requestId" dans Firestore (collection interne).
  const idemRef = db.collection('_Idempotency').doc(`v1_requests:${uid}:${idempotencyKey}`);

  // Champs essentiels pour calcul serveur
  const reqType = String(pickLegacyField(requestRaw, ['Request Type']) ?? '').trim();
  const reqCategory = String(pickLegacyField(requestRaw, ['Request Category']) ?? '').trim();
  const membership = (String(pickLegacyField(requestRaw, ['Membership Type']) ?? '').trim() || clientCtx.membership || null) as MembershipType | null;

  const assignedTo = await resolveAssignedTo({ uid, requestType: reqType, requestCategory: reqCategory, clientLanguage: clientCtx.language });
  const priority = computePriority({ requestType: reqType, requestCategory: reqCategory, membership });
  const waitingTimeRaw = String(pickLegacyField(requestRaw, ["Temps d'attente"]) ?? '').trim() || null;
  const waitingTime = calculateAdjustedWaitingTime(waitingTimeRaw, membership);

  const { requestId, firestoreWritePerformed } = await db.runTransaction(async (tx) => {
    const idemSnap = await tx.get(idemRef);
    const existing = idemSnap.exists ? (idemSnap.data() as any)?.requestId : null;
    if (typeof existing === 'string' && existing.trim()) {
      return { requestId: existing.trim(), firestoreWritePerformed: false };
    }

    const requestRef = db.collection('Clients').doc(uid).collection('Requests').doc();
    const newId = requestRef.id;

    const converted = deepConvertIsoDatesToTimestamps(requestRaw) as Record<string, unknown>;

    // Ajouts server-side (legacy + nouveau)
    const nowServer = admin.firestore.FieldValue.serverTimestamp();
    const data: Record<string, unknown> = {
      ...converted,
      // garantir uid
      'User ID': uid,
      // champs calculés serveur
      Status: 'Assigned',
      'Assigned to': assignedTo,
      Priority: priority,
      "Temps d'attente": waitingTime,
      // clean flow compat
      Platform: String(pickLegacyField(converted, ['Platform']) ?? 'mobile'),
      Version: String(pickLegacyField(converted, ['Version']) ?? '2.0'),
      'Membership Type': membership,
      // timestamps server-side (legacy)
      'Request Date': nowServer,
      'Created At': nowServer,
      'Updated At': nowServer
    };

    // Normalisations legacy: certains écrans attendent des clés précises
    // - For who ? / Location / Active Step
    if (!('For who ?' in data) && 'Request_ForWho' in data) data['For who ?'] = (data as any).Request_ForWho;
    if (!('Location' in data) && 'Request_Location' in data) data['Location'] = (data as any).Request_Location;
    if (!('Active Step' in data) && 'Request_ActiveStep' in data) data['Active Step'] = (data as any).Request_ActiveStep;

    tx.set(requestRef, data, { merge: true });
    tx.set(idemRef, { requestId: newId, uid, source, createdAt: nowServer }, { merge: false });
    return { requestId: newId, firestoreWritePerformed: true };
  });

  // Upsert Supabase: on renvoie un statut pour visibilité (sans bloquer si panne)
  let supabaseResult: { inserted: boolean; id: string | null } = { inserted: false, id: null };
  if (firestoreWritePerformed) {
    supabaseResult = await upsertSupabaseRequest({
      uid,
      requestId,
      source,
      idempotencyKey,
      request: requestRaw,
      computed: { assignedTo, priority, waitingTime }
    });
  }

  const uploadedFiles = normalizeStringArray(pickLegacyField(requestRaw, ['Uploaded Files'])) || [];

  res.status(201).json({
    requestId,
    assignedTo,
    priority,
    waitingTime,
    uploadedFiles,
    supabase: supabaseResult
  });
}

