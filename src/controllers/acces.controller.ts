import type { Response } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { getFirestore } from '../config/firebase.js';
import { HttpError } from '../utils/errors.js';
import { supabase } from '../services/supabase.service.js';
import { resolveSupabaseClientId } from '../services/dualWrite.service.js';
import { dualWriteAcces, dualWriteClientLog, dualWriteDelete } from '../services/dualWrite.service.js';

export async function getAcces(req: AuthenticatedRequest, res: Response) {
  const uid = req.uid!;
  const clientId = await resolveSupabaseClientId(uid);

  const { data, error } = await supabase
    .from('client_access_credentials')
    .select('*')
    .eq('client_id', clientId);

  if (error) throw error;

  const acces = (data || []).map((a: any) => ({ id: a.id, ...a }));

  res.json({ acces });
}

export async function addAcces(req: AuthenticatedRequest, res: Response) {
  const uid = req.uid!;
  const db = getFirestore();
  const data = req.body;

  if (!data || typeof data !== 'object') {
    throw new HttpError(400, 'Body required');
  }

  const accesData = { ...data, createdAt: new Date().toISOString() };
  const docRef = await db
    .collection('Clients')
    .doc(uid)
    .collection('Client Acces')
    .add(accesData);

  dualWriteAcces(uid, docRef.id, accesData).catch(() => {});

  res.status(201).json({ id: docRef.id, ...data });
}

export async function deleteAcces(req: AuthenticatedRequest, res: Response) {
  const uid = req.uid!;
  const { accesId } = req.params;
  const db = getFirestore();

  await db
    .collection('Clients')
    .doc(uid)
    .collection('Client Acces')
    .doc(accesId)
    .delete();

  dualWriteDelete('client_access_credentials', 'firestore_id', accesId).catch(() => {});

  res.json({ message: 'Accès supprimé' });
}

export async function createLog(req: AuthenticatedRequest, res: Response) {
  const uid = req.uid!;
  const db = getFirestore();
  const { action, description, metadata } = req.body;

  if (!action || !description) {
    throw new HttpError(400, 'action and description required');
  }

  const logData = {
    action,
    description,
    metadata: metadata || {},
    createdAt: new Date().toISOString(),
    uid,
  };
  const docRef = await db
    .collection('Clients')
    .doc(uid)
    .collection('Client Logs')
    .add({ action, description, ...(metadata || {}), createdAt: logData.createdAt, uid });

  dualWriteClientLog(uid, docRef.id, logData).catch(() => {});

  res.status(201).json({ id: docRef.id });
}

export async function getLogs(req: AuthenticatedRequest, res: Response) {
  const uid = req.uid!;
  const clientId = await resolveSupabaseClientId(uid);
  const limit = Math.min(Number(req.query.limit) || 50, 200);

  const { data, error } = await supabase
    .from('client_logs')
    .select('*')
    .eq('client_id', clientId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;

  const logs = (data || []).map((l: any) => ({ id: l.id, ...l }));

  res.json({ logs });
}
