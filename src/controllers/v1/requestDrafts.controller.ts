import type { Response } from 'express';
import type { AuthenticatedRequest } from '../../middleware/auth.middleware.js';
import { admin, getFirestore } from '../../config/firebase.js';

type DraftType = 'manual_conversational' | 'voice_stepflow' | 'housing_inscription';

const MAX_DRAFTS_PER_USER = 10;
const DRAFT_TTL_DAYS = 30;

function isRecord(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === 'object' && !Array.isArray(x);
}

function normalizeNonEmptyString(raw: unknown, maxLen: number): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;
  return s.slice(0, maxLen);
}

function normalizeOptionalString(raw: unknown, maxLen: number): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  return s ? s.slice(0, maxLen) : null;
}

function normalizeDraftType(raw: unknown): DraftType | null {
  const s = String(raw ?? '').trim();
  if (s === 'manual_conversational' || s === 'voice_stepflow' || s === 'housing_inscription') return s;
  return null;
}

function normalizeProgress(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n)) return null;
  // clamp
  return Math.max(0, Math.min(1, n));
}

function normalizeStringArray(raw: unknown, maxItems = 200, maxLen = 2000): string[] | null {
  if (raw === null || raw === undefined) return null;
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  for (const item of raw) {
    if (out.length >= maxItems) break;
    const s = String(item ?? '').trim();
    if (!s) continue;
    out.push(s.slice(0, maxLen));
  }
  return out;
}

function toDateOrNull(value: any): Date | null {
  if (!value) return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  if (typeof value?.toDate === 'function') {
    try {
      const d = value.toDate();
      return d instanceof Date && Number.isFinite(d.getTime()) ? d : null;
    } catch {
      return null;
    }
  }
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) {
    const d = new Date(n);
    return Number.isFinite(d.getTime()) ? d : null;
  }
  return null;
}

function toIsoOrNull(value: any): string | null {
  const d = toDateOrNull(value);
  return d ? d.toISOString() : null;
}

function addDays(now: Date, days: number): Date {
  return new Date(now.getTime() + Math.max(0, days) * 24 * 60 * 60 * 1000);
}

function draftsCollection(db: FirebaseFirestore.Firestore, uid: string) {
  return db.collection('Clients').doc(uid).collection('RequestDrafts');
}

function serializeDraft(doc: FirebaseFirestore.QueryDocumentSnapshot | FirebaseFirestore.DocumentSnapshot) {
  const data = (doc.data() || {}) as Record<string, any>;
  const uploaded = Array.isArray(data.uploaded_urls) ? data.uploaded_urls : [];
  return {
    id: doc.id,
    type: String(data.type || ''),
    title: typeof data.title === 'string' ? data.title : null,
    category: typeof data.category === 'string' ? data.category : null,
    subcategory: typeof data.subcategory === 'string' ? data.subcategory : null,
    progress: typeof data.progress === 'number' && Number.isFinite(data.progress) ? data.progress : 0,
    current_step: typeof data.current_step === 'string' ? data.current_step : null,
    snapshot_json: isRecord(data.snapshot_json) ? data.snapshot_json : data.snapshot_json ?? {},
    uploaded_urls: uploaded.map((x: any) => String(x ?? '').trim()).filter(Boolean),
    created_at: toIsoOrNull(data.created_at),
    updated_at: toIsoOrNull(data.updated_at)
  };
}

export async function v1CreateRequestDraft(req: AuthenticatedRequest, res: Response): Promise<void> {
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

  const type = normalizeDraftType(body.type);
  if (!type) {
    res.status(400).json({ message: 'type invalide.' });
    return;
  }

  const title = normalizeOptionalString(body.title, 255);
  const category = normalizeOptionalString(body.category, 255);
  const subcategory = normalizeOptionalString(body.subcategory, 255);
  let progress = 0;
  if ('progress' in body) {
    const p = normalizeProgress(body.progress);
    if (p === null) {
      res.status(400).json({ message: 'progress invalide.' });
      return;
    }
    progress = p;
  }
  const current_step = normalizeOptionalString(body.current_step, 100);

  const snapshot_json = body.snapshot_json;
  if (snapshot_json !== null && snapshot_json !== undefined && !isRecord(snapshot_json)) {
    res.status(400).json({ message: 'snapshot_json invalide.' });
    return;
  }

  let uploaded_urls: string[] = [];
  if ('uploaded_urls' in body) {
    const urls = normalizeStringArray(body.uploaded_urls);
    if (urls === null) {
      res.status(400).json({ message: 'uploaded_urls invalide.' });
      return;
    }
    uploaded_urls = urls;
  }

  const clientTempId = normalizeOptionalString(body.id, 128);

  const db = getFirestore();
  const col = draftsCollection(db, uid);
  const ref = col.doc(); // ID généré par le backend

  const now = new Date();
  const expiresAt = admin.firestore.Timestamp.fromDate(addDays(now, DRAFT_TTL_DAYS));
  const serverNow = admin.firestore.FieldValue.serverTimestamp();

  await db.runTransaction(async (tx) => {
    // Limite "max 10" par utilisateur: on évince le plus ancien si besoin.
    const existingSnap = await tx.get(col.orderBy('updated_at', 'desc').limit(MAX_DRAFTS_PER_USER));
    if (existingSnap.size >= MAX_DRAFTS_PER_USER) {
      const oldest = existingSnap.docs[existingSnap.docs.length - 1];
      tx.delete(oldest.ref);
    }

    tx.set(
      ref,
      {
        uid,
        type,
        title,
        category,
        subcategory,
        progress,
        current_step,
        snapshot_json: snapshot_json ?? {},
        uploaded_urls,
        client_temp_id: clientTempId,
        created_at: serverNow,
        updated_at: serverNow,
        expires_at: expiresAt
      },
      { merge: false }
    );
  });

  res.status(201).json({ id: ref.id, draftId: ref.id });
}

export async function v1ListRequestDrafts(req: AuthenticatedRequest, res: Response): Promise<void> {
  const uid = String(req.uid || '').trim();
  if (!uid) {
    res.status(401).json({ message: 'Vous devez être connecté.' });
    return;
  }

  const db = getFirestore();
  const col = draftsCollection(db, uid);

  const snap = await col.orderBy('updated_at', 'desc').limit(MAX_DRAFTS_PER_USER).get();

  const now = new Date();
  const expiredRefs: FirebaseFirestore.DocumentReference[] = [];
  const drafts = snap.docs
    .filter((d) => {
      const data = (d.data() || {}) as any;
      const exp = toDateOrNull(data.expires_at);
      if (exp && exp.getTime() <= now.getTime()) {
        expiredRefs.push(d.ref);
        return false;
      }
      return true;
    })
    .map((d) => serializeDraft(d));

  // Nettoyage opportuniste (non bloquant) des drafts expirés
  if (expiredRefs.length) {
    void Promise.allSettled(expiredRefs.map((r) => r.delete()));
  }

  res.status(200).json({ drafts });
}

export async function v1PatchRequestDraft(req: AuthenticatedRequest, res: Response): Promise<void> {
  const uid = String(req.uid || '').trim();
  if (!uid) {
    res.status(401).json({ message: 'Vous devez être connecté.' });
    return;
  }

  const draftId = normalizeNonEmptyString((req.params as any)?.draftId, 128);
  if (!draftId) {
    res.status(400).json({ message: 'draftId invalide.' });
    return;
  }

  const body = req.body as unknown;
  if (!isRecord(body)) {
    res.status(400).json({ message: 'Body invalide.' });
    return;
  }

  const db = getFirestore();
  const ref = draftsCollection(db, uid).doc(draftId);
  const existing = await ref.get();
  if (!existing.exists) {
    res.status(404).json({ message: 'Brouillon introuvable.' });
    return;
  }

  const update: Record<string, unknown> = {};

  if ('type' in body) {
    const type = normalizeDraftType(body.type);
    if (!type) {
      res.status(400).json({ message: 'type invalide.' });
      return;
    }
    update.type = type;
  }

  if ('title' in body) update.title = normalizeOptionalString(body.title, 255);
  if ('category' in body) update.category = normalizeOptionalString(body.category, 255);
  if ('subcategory' in body) update.subcategory = normalizeOptionalString(body.subcategory, 255);

  if ('progress' in body) {
    const p = normalizeProgress(body.progress);
    if (p === null) {
      res.status(400).json({ message: 'progress invalide.' });
      return;
    }
    update.progress = p;
  }

  if ('current_step' in body) update.current_step = normalizeOptionalString(body.current_step, 100);

  if ('snapshot_json' in body) {
    const snapshot_json = (body as any).snapshot_json;
    if (snapshot_json !== null && snapshot_json !== undefined && !isRecord(snapshot_json)) {
      res.status(400).json({ message: 'snapshot_json invalide.' });
      return;
    }
    update.snapshot_json = snapshot_json ?? {};
  }

  if ('uploaded_urls' in body) {
    const urls = normalizeStringArray((body as any).uploaded_urls);
    if (urls === null) {
      res.status(400).json({ message: 'uploaded_urls invalide.' });
      return;
    }
    update.uploaded_urls = urls;
  }

  const now = new Date();
  update.updated_at = admin.firestore.FieldValue.serverTimestamp();
  update.expires_at = admin.firestore.Timestamp.fromDate(addDays(now, DRAFT_TTL_DAYS));

  await ref.set(update, { merge: true });

  res.status(200).json({ success: true });
}

export async function v1DeleteRequestDraft(req: AuthenticatedRequest, res: Response): Promise<void> {
  const uid = String(req.uid || '').trim();
  if (!uid) {
    res.status(401).json({ message: 'Vous devez être connecté.' });
    return;
  }

  const draftId = normalizeNonEmptyString((req.params as any)?.draftId, 128);
  if (!draftId) {
    res.status(400).json({ message: 'draftId invalide.' });
    return;
  }

  const db = getFirestore();
  const ref = draftsCollection(db, uid).doc(draftId);
  const snap = await ref.get();
  if (!snap.exists) {
    res.status(404).json({ message: 'Brouillon introuvable.' });
    return;
  }

  await ref.delete();
  res.status(200).json({ success: true });
}

/**
 * Endpoint optionnel (non utilisé par le frontend actuellement).
 * On le publie pour compat contract, mais il exige une structure supplémentaire
 * (payload(s) de création de demandes) non définie dans ce document.
 */
export async function v1FinalizeRequestDraft(_req: AuthenticatedRequest, res: Response): Promise<void> {
  res.status(501).json({
    message:
      "Endpoint non implémenté: le frontend crée aujourd'hui les demandes via POST /v1/requests puis supprime le brouillon."
  });
}

