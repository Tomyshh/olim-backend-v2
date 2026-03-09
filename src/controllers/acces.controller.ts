import type { Response } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { getFirestore } from '../config/firebase.js';
import { HttpError } from '../utils/errors.js';

export async function getAcces(req: AuthenticatedRequest, res: Response) {
  const uid = req.uid!;
  const db = getFirestore();

  const snapshot = await db
    .collection('Clients')
    .doc(uid)
    .collection('Client Acces')
    .get();

  const acces = snapshot.docs.map(doc => ({
    id: doc.id,
    ...doc.data(),
  }));

  res.json({ acces });
}

export async function addAcces(req: AuthenticatedRequest, res: Response) {
  const uid = req.uid!;
  const db = getFirestore();
  const data = req.body;

  if (!data || typeof data !== 'object') {
    throw new HttpError(400, 'Body required');
  }

  const docRef = await db
    .collection('Clients')
    .doc(uid)
    .collection('Client Acces')
    .add({
      ...data,
      createdAt: new Date().toISOString(),
    });

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

  res.json({ message: 'Accès supprimé' });
}

export async function createLog(req: AuthenticatedRequest, res: Response) {
  const uid = req.uid!;
  const db = getFirestore();
  const { action, description, metadata } = req.body;

  if (!action || !description) {
    throw new HttpError(400, 'action and description required');
  }

  const docRef = await db
    .collection('Clients')
    .doc(uid)
    .collection('Client Logs')
    .add({
      action,
      description,
      ...(metadata || {}),
      createdAt: new Date().toISOString(),
      uid,
    });

  res.status(201).json({ id: docRef.id });
}

export async function getLogs(req: AuthenticatedRequest, res: Response) {
  const uid = req.uid!;
  const db = getFirestore();
  const limit = Math.min(Number(req.query.limit) || 50, 200);

  const snapshot = await db
    .collection('Clients')
    .doc(uid)
    .collection('Client Logs')
    .orderBy('createdAt', 'desc')
    .limit(limit)
    .get();

  const logs = snapshot.docs.map(doc => ({
    id: doc.id,
    ...doc.data(),
  }));

  res.json({ logs });
}
