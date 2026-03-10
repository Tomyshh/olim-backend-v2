import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { getFirestore } from '../config/firebase.js';
import { dualWriteToSupabase, resolveSupabaseClientId, mapAppointmentToSupabase } from '../services/dualWrite.service.js';

export async function getAppointments(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const db = getFirestore();
    const { status, limit = 50 } = req.query;

    let query = db.collection('Clients').doc(uid).collection('appointments');

    if (status) {
      query = query.where('status', '==', status) as any;
    }

    const snapshot = await query.orderBy('date', 'desc').limit(Number(limit)).get();

    const appointments = snapshot.docs.map(doc => ({
      appointmentId: doc.id,
      ...doc.data()
    }));

    res.json({ appointments });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function getAppointmentDetail(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const { appointmentId } = req.params;
    const db = getFirestore();

    const appointmentDoc = await db
      .collection('Clients')
      .doc(uid)
      .collection('appointments')
      .doc(appointmentId)
      .get();

    if (!appointmentDoc.exists) {
      res.status(404).json({ error: 'Appointment not found' });
      return;
    }

    res.json({ appointmentId, ...appointmentDoc.data() });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function createAppointment(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const { slotId, requestId, notes } = req.body;
    const db = getFirestore();

    // Récupérer infos du créneau
    const slotDoc = await db.collection('AvailableSlots').doc(slotId).get();
    if (!slotDoc.exists) {
      res.status(404).json({ error: 'Slot not found' });
      return;
    }

    const slotData = slotDoc.data()!;

    const newAppointment = {
      requestId: requestId || null,
      slotId,
      date: slotData.date,
      time: slotData.time,
      status: 'scheduled',
      notes: notes || '',
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const appointmentRef = await db
      .collection('Clients')
      .doc(uid)
      .collection('appointments')
      .add(newAppointment);

    resolveSupabaseClientId(uid).then(cid => {
      if (cid) dualWriteToSupabase('appointments', mapAppointmentToSupabase(cid, appointmentRef.id, newAppointment), { onConflict: 'firestore_id' });
    }).catch(() => {});

    res.status(201).json({ appointmentId: appointmentRef.id, ...newAppointment });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function updateAppointment(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const { appointmentId } = req.params;
    const updates = req.body;
    const db = getFirestore();

    await db
      .collection('Clients')
      .doc(uid)
      .collection('appointments')
      .doc(appointmentId)
      .update({
        ...updates,
        updatedAt: new Date()
      });

    const updatedDoc = await db
      .collection('Clients')
      .doc(uid)
      .collection('appointments')
      .doc(appointmentId)
      .get();

    resolveSupabaseClientId(uid).then(cid => {
      if (cid) dualWriteToSupabase('appointments', mapAppointmentToSupabase(cid, appointmentId, updatedDoc.data()!), { onConflict: 'firestore_id' });
    }).catch(() => {});

    res.json({ appointmentId, ...updatedDoc.data() });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function cancelAppointment(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const { appointmentId } = req.params;
    const db = getFirestore();

    const cancelledAt = new Date();

    await db
      .collection('Clients')
      .doc(uid)
      .collection('appointments')
      .doc(appointmentId)
      .update({
        status: 'cancelled',
        updatedAt: cancelledAt
      });

    dualWriteToSupabase('appointments', { status: 'cancelled', updated_at: cancelledAt.toISOString() }, { mode: 'update', matchColumn: 'firestore_id', matchValue: appointmentId }).catch(() => {});

    res.json({ message: 'Appointment cancelled', appointmentId });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function getAvailableSlots(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const db = getFirestore();
    const { date, limit = 100 } = req.query;

    let query = db.collection('AvailableSlots').where('available', '==', true);

    if (date) {
      query = query.where('date', '==', date) as any;
    }

    const snapshot = await query.orderBy('date').orderBy('time').limit(Number(limit)).get();

    const slots = snapshot.docs.map(doc => ({
      slotId: doc.id,
      ...doc.data()
    }));

    res.json({ slots });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

