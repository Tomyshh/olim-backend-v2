import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { getFirestore } from '../config/firebase.js';
import { dualWriteToSupabase, resolveSupabaseClientId, mapHealthRequestToSupabase } from '../services/dualWrite.service.js';

export async function getHealthRequests(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const db = getFirestore();

    const requestsSnapshot = await db
      .collection('Clients')
      .doc(uid)
      .collection('health_requests')
      .orderBy('createdAt', 'desc')
      .get();

    const requests = requestsSnapshot.docs.map(doc => ({
      requestId: doc.id,
      ...doc.data()
    }));

    res.json({ requests });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function getHealthRequestDetail(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const { requestId } = req.params;
    const db = getFirestore();

    const requestDoc = await db
      .collection('Clients')
      .doc(uid)
      .collection('health_requests')
      .doc(requestId)
      .get();

    if (!requestDoc.exists) {
      res.status(404).json({ error: 'Health request not found' });
      return;
    }

    res.json({ requestId, ...requestDoc.data() });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function createHealthRequest(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const { type, description, data } = req.body;
    const db = getFirestore();

    const requestRef = await db
      .collection('Clients')
      .doc(uid)
      .collection('health_requests')
      .add({
        type: type || 'general',
        description: description || '',
        data: data || {},
        status: 'pending',
        createdAt: new Date()
      });

    // Créer copie admin
    await db.collection('HealthRequests').doc(requestRef.id).set({
      uid,
      type: type || 'general',
      description: description || '',
      data: data || {},
      status: 'pending',
      createdAt: new Date()
    });

    resolveSupabaseClientId(uid).then(clientId => {
      dualWriteToSupabase('health_requests', mapHealthRequestToSupabase(clientId, requestRef.id, uid, {
        type: type || 'general', description: description || '', data: data || {}, status: 'pending', createdAt: new Date()
      }), { mode: 'insert' });
    }).catch(() => {});

    res.status(201).json({
      requestId: requestRef.id,
      type,
      description,
      status: 'pending'
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function updateHealthRequest(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const { requestId } = req.params;
    const updates = req.body;
    const db = getFirestore();

    await db
      .collection('Clients')
      .doc(uid)
      .collection('health_requests')
      .doc(requestId)
      .update(updates);

    // Mettre à jour copie admin
    await db.collection('HealthRequests').doc(requestId).update(updates);

    dualWriteToSupabase('health_requests', {
      ...updates,
      updated_at: new Date().toISOString()
    }, { mode: 'update', matchColumn: 'firestore_id', matchValue: requestId }).catch(() => {});

    res.json({ message: 'Health request updated', requestId });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function getHealthConfig(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const db = getFirestore();

    const configDoc = await db
      .collection('Clients')
      .doc(uid)
      .collection('settings')
      .doc('health_config')
      .get();

    if (!configDoc.exists) {
      res.json({ config: {} });
      return;
    }

    res.json({ config: configDoc.data() });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function updateHealthConfig(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const config = req.body;
    const db = getFirestore();

    await db
      .collection('Clients')
      .doc(uid)
      .collection('settings')
      .doc('health_config')
      .set(config, { merge: true });

    resolveSupabaseClientId(uid).then(clientId => {
      if (!clientId) return;
      dualWriteToSupabase('health_configs', {
        client_id: clientId,
        client_firebase_uid: uid,
        config_data: config,
        updated_at: new Date().toISOString()
      }, { onConflict: 'client_id' });
    }).catch(() => {});

    res.json({ message: 'Health config updated', config });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

