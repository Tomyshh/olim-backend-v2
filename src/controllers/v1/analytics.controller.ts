import type { Response } from 'express';
import type { AuthenticatedRequest } from '../../middleware/auth.middleware.js';
import { supabase } from '../../services/supabase.service.js';

function isRecord(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === 'object' && !Array.isArray(x);
}

async function tryInsert(table: string, candidates: Record<string, unknown>[]): Promise<void> {
  let lastErr: any = null;
  for (const payload of candidates) {
    const { error } = await supabase.from(table).insert(payload as any);
    if (!error) return;
    lastErr = error;

    // Si c'est une erreur “colonne n’existe pas”, on essaie le payload suivant.
    const msg = String((error as any)?.message || '').toLowerCase();
    if (msg.includes('column') && msg.includes('does not exist')) continue;
    if (msg.includes('unknown') && msg.includes('column')) continue;

    // Sinon: on arrête (contrainte, RLS, etc.)
    break;
  }
  if (lastErr) {
    console.error(`[v1/analytics] insert failed (${table})`, { message: lastErr.message, details: (lastErr as any).details });
  }
}

function pickCreatedAt(body: Record<string, unknown>): string | null {
  const raw = body.createdAt ?? body.created_at ?? null;
  if (!raw) return null;
  const s = String(raw).trim();
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

export async function v1RegistrationSessionStart(req: AuthenticatedRequest, res: Response): Promise<void> {
  const uid = String(req.uid || '').trim();
  if (!uid) {
    res.status(401).json({ message: 'Vous devez être connecté.' });
    return;
  }
  const body = isRecord(req.body) ? req.body : {};
  const createdAt = pickCreatedAt(body);

  await tryInsert('registration_sessions', [
    { firebase_uid: uid, started_at: createdAt ?? new Date().toISOString(), metadata: body },
    { user_id: uid, started_at: createdAt ?? new Date().toISOString(), metadata: body },
    { uid, started_at: createdAt ?? new Date().toISOString(), metadata: body },
    { firebase_uid: uid, payload: body },
    { firebase_uid: uid, metadata: body }
  ]);

  res.status(204).send();
}

export async function v1RegistrationStep(req: AuthenticatedRequest, res: Response): Promise<void> {
  const uid = String(req.uid || '').trim();
  if (!uid) {
    res.status(401).json({ message: 'Vous devez être connecté.' });
    return;
  }
  const body = isRecord(req.body) ? req.body : {};
  const createdAt = pickCreatedAt(body);

  await tryInsert('registration_steps', [
    { firebase_uid: uid, created_at: createdAt, step: body.step ?? body.name ?? null, metadata: body },
    { user_id: uid, created_at: createdAt, step: body.step ?? body.name ?? null, metadata: body },
    { firebase_uid: uid, payload: body },
    { firebase_uid: uid, metadata: body }
  ]);

  res.status(204).send();
}

export async function v1RegistrationError(req: AuthenticatedRequest, res: Response): Promise<void> {
  const uid = String(req.uid || '').trim();
  if (!uid) {
    res.status(401).json({ message: 'Vous devez être connecté.' });
    return;
  }
  const body = isRecord(req.body) ? req.body : {};
  const createdAt = pickCreatedAt(body);

  await tryInsert('registration_errors', [
    {
      firebase_uid: uid,
      created_at: createdAt,
      step: body.step ?? body.name ?? null,
      message: body.message ?? body.error ?? null,
      metadata: body
    },
    { user_id: uid, created_at: createdAt, message: body.message ?? body.error ?? null, metadata: body },
    { firebase_uid: uid, payload: body },
    { firebase_uid: uid, metadata: body }
  ]);

  res.status(204).send();
}

export async function v1RegistrationSessionComplete(req: AuthenticatedRequest, res: Response): Promise<void> {
  const uid = String(req.uid || '').trim();
  if (!uid) {
    res.status(401).json({ message: 'Vous devez être connecté.' });
    return;
  }
  const body = isRecord(req.body) ? req.body : {};
  const createdAt = pickCreatedAt(body);

  await tryInsert('registration_sessions', [
    { firebase_uid: uid, completed_at: createdAt ?? new Date().toISOString(), status: 'complete', metadata: body },
    { user_id: uid, completed_at: createdAt ?? new Date().toISOString(), status: 'complete', metadata: body },
    { firebase_uid: uid, payload: body },
    { firebase_uid: uid, metadata: body }
  ]);

  res.status(204).send();
}

export async function v1VoiceRequests(req: AuthenticatedRequest, res: Response): Promise<void> {
  const uid = String(req.uid || '').trim();
  if (!uid) {
    res.status(401).json({ message: 'Vous devez être connecté.' });
    return;
  }
  const body = req.body;
  if (!isRecord(body)) {
    res.status(400).json({ message: 'Body invalide.' });
    return;
  }

  const createdAt = pickCreatedAt(body);

  // Table décrite dans SCHEMA_SUPABASE.md: voice_requests
  const payload: Record<string, unknown> = {
    subgroup_id: body.subgroupId ?? body.subgroup_id ?? null,
    transcription: body.transcription ?? null,
    matched_group_name: body.matchedGroupName ?? body.matched_group_name ?? null,
    matched_subgroup_name: body.matchedSubGroupName ?? body.matched_subgroup_name ?? null
  };
  if (createdAt) payload.created_at = createdAt;

  // On stocke aussi uid en metadata si la table le supporte (fallback silencieux)
  await tryInsert('voice_requests', [
    payload,
    { ...payload, firebase_uid: uid },
    { ...payload, metadata: { uid, ...body } }
  ]);

  res.status(204).send();
}

