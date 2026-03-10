import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { getFirestore } from '../config/firebase.js';
import { dualWriteToSupabase, resolveSupabaseClientId, mapAppointmentToSupabase } from '../services/dualWrite.service.js';
import { supabase } from '../services/supabase.service.js';

export async function getAppointments(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const { status, limit = 50 } = req.query;

    const clientId = await resolveSupabaseClientId(uid);
    if (!clientId) { res.json({ appointments: [] }); return; }

    let query = supabase
      .from('appointments')
      .select('*')
      .eq('client_id', clientId)
      .order('date', { ascending: false })
      .limit(Number(limit));

    if (status) {
      query = query.eq('status', status as string);
    }

    const { data, error } = await query;
    if (error) throw error;

    const appointments = (data || []).map(a => ({
      appointmentId: a.firestore_id || a.id,
      ...a
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

    const { data, error } = await supabase
      .from('appointments')
      .select('*')
      .or(`firestore_id.eq.${appointmentId},id.eq.${appointmentId}`)
      .single();

    if (error || !data) {
      res.status(404).json({ error: 'Appointment not found' });
      return;
    }

    res.json({ appointmentId: data.firestore_id || data.id, ...data });
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
    const { date, limit = 100 } = req.query;

    let query = supabase
      .from('available_slots')
      .select('*')
      .eq('available', true)
      .order('date', { ascending: true })
      .order('time', { ascending: true })
      .limit(Number(limit));

    if (date) {
      query = query.eq('date', date as string);
    }

    const { data, error } = await query;
    if (error) throw error;

    const slots = (data || []).map(s => ({
      slotId: s.firestore_id || s.id,
      ...s
    }));

    res.json({ slots });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

