import type { Response } from 'express';
import type { AuthenticatedRequest } from '../../middleware/auth.middleware.js';
import { getFirestore, admin } from '../../config/firebase.js';
import { supabase } from '../../services/supabase.service.js';

type RequestSource = 'APP' | 'VOICE' | 'SHARE' | 'SYSTEM';

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

async function upsertSupabaseRequest(params: {
  uid: string;
  requestId: string;
  source: RequestSource;
  idempotencyKey: string;
  request: Record<string, unknown>;
}): Promise<void> {
  const { uid, requestId, source, idempotencyKey, request } = params;

  const requestType = String(pickLegacyField(request, ['Request Type', 'request_type', 'requestType']) ?? '').trim();
  const requestCategory = String(pickLegacyField(request, ['Request Category', 'request_category', 'category']) ?? '').trim();
  const requestSubCategory = String(pickLegacyField(request, ['Request Sub-Category', 'request_sub_category', 'subCategory']) ?? '').trim();
  const description = String(pickLegacyField(request, ['Description', 'request_description', 'description']) ?? '').trim();
  const status = String(pickLegacyField(request, ['Status', 'status']) ?? '').trim() || 'Assigned';
  const assignedTo = String(pickLegacyField(request, ['Assigned to', 'assigned_to']) ?? '').trim() || null;
  const categoryId = String(pickLegacyField(request, ['Category ID', 'category_id']) ?? '').trim() || null;
  const subCategoryId = String(pickLegacyField(request, ['SubCategory ID', 'sub_category_id']) ?? '').trim() || null;

  const priorityRaw = pickLegacyField(request, ['Priority', 'priority']);
  const priority = normalizePriority(priorityRaw);

  const firstName = String(pickLegacyField(request, ['First Name', 'first_name']) ?? '').trim() || null;
  const lastName = String(pickLegacyField(request, ['Last Name', 'last_name']) ?? '').trim() || null;
  const email = String(pickLegacyField(request, ['Email', 'email']) ?? '').trim() || null;
  const phone = String(pickLegacyField(request, ['Phone', 'phone', 'Phone Number']) ?? '').trim() || null;
  const membershipType = String(pickLegacyField(request, ['Membership', 'membership_type', 'Membership Type']) ?? '').trim() || null;

  const uniqueId = `${source}-${requestId}-${uid.slice(0, 8)}`;

  const payload: Record<string, unknown> = {
    firebase_request_id: requestId,
    unique_id: uniqueId,
    user_id: uid,
    request_type: requestType || 'unknown',
    request_category: requestCategory || 'unknown',
    request_sub_category: requestSubCategory || null,
    request_description: description || null,
    status,
    priority: priority ?? undefined,
    assigned_to: assignedTo,
    category_id: categoryId,
    sub_category_id: subCategoryId,
    first_name: firstName,
    last_name: lastName,
    email,
    phone,
    membership_type: membershipType,
    source,
    created_by: source,
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

  const { error } = await supabase.from('requests').upsert(payload as any, { onConflict: 'unique_id' });
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
  }
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

  // Idempotency robuste même si Redis est absent:
  // on stocke une "clé -> requestId" dans Firestore (collection interne).
  const idemRef = db.collection('_Idempotency').doc(`v1_requests:${uid}:${idempotencyKey}`);

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
      userId: uid,
      // timestamps server-side (legacy + nouveau)
      'Created At': nowServer,
      'Updated At': nowServer,
      createdAt: nowServer,
      updatedAt: nowServer
    };

    // Request Date: si absent, on le force côté serveur
    if (!('Request Date' in data) && !('request_date' in data) && !('requestDate' in data)) {
      data['Request Date'] = nowServer;
    }

    tx.set(requestRef, data, { merge: true });
    tx.set(idemRef, { requestId: newId, uid, source, createdAt: nowServer }, { merge: false });
    return { requestId: newId, firestoreWritePerformed: true };
  });

  // Upsert Supabase best-effort
  // On évite de relancer si idempotency HIT (on peut le faire quand même, upsert est idempotent)
  // mais on réduit la charge.
  if (firestoreWritePerformed) {
    void upsertSupabaseRequest({
      uid,
      requestId,
      source,
      idempotencyKey,
      request: requestRaw
    });
  }

  res.status(201).json({ requestId });
}

