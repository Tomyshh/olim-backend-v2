import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { getFirestore } from '../config/firebase.js';
import { dualWriteToSupabase, resolveSupabaseClientId, mapAppointmentToSupabase } from '../services/dualWrite.service.js';
import { supabase } from '../services/supabase.service.js';
import { supabaseFirstRead } from '../services/supabaseFirstRead.service.js';
import { supabaseInsertThenFirestore, supabaseUpdateThenFirestore } from '../services/supabaseFirstWrite.service.js';

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
    if (error) {
      // Table might not exist yet – return empty gracefully
      if (error.code === '42P01' || error.message?.includes('does not exist')) {
        res.json({ appointments: [] });
        return;
      }
      throw error;
    }

    const appointments = (data || []).map(a => ({
      appointmentId: a.firestore_id || a.id,
      ...a,
      // Legacy aliases
      date: a.date ?? '',
      time: a.time ?? '',
      status: a.status ?? '',
      notes: a.notes ?? '',
      requestId: a.request_id ?? a.requestId ?? null,
      slotId: a.slot_id ?? null,
      createdAt: a.created_at ?? '',
      updatedAt: a.updated_at ?? '',
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

    const clientId = await resolveSupabaseClientId(uid);
    if (!clientId) { res.status(404).json({ error: 'Appointment not found' }); return; }

    const { data, error } = await supabase
      .from('appointments')
      .select('*')
      .eq('client_id', clientId)
      .or(`firestore_id.eq.${appointmentId},id.eq.${appointmentId}`)
      .single();

    if (error || !data) {
      res.status(404).json({ error: 'Appointment not found' });
      return;
    }

    res.json({
      appointmentId: data.firestore_id || data.id,
      ...data,
      // Legacy aliases
      date: data.date ?? '',
      time: data.time ?? '',
      status: data.status ?? '',
      notes: data.notes ?? '',
      requestId: data.request_id ?? data.requestId ?? null,
      slotId: data.slot_id ?? null,
      createdAt: data.created_at ?? '',
      updatedAt: data.updated_at ?? '',
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function createAppointment(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const { slotId, requestId, notes } = req.body;
    const db = getFirestore();

    const slotResult = await supabaseFirstRead(
      async () => {
        const { data, error } = await supabase
          .from('available_slots')
          .select('*')
          .or(`firestore_id.eq.${slotId},id.eq.${slotId}`)
          .maybeSingle();
        if (error) throw error;
        if (!data) return null as any;
        return { date: data.date, time: data.time, available: data.available };
      },
      async () => {
        const doc = await db.collection('AvailableSlots').doc(slotId).get();
        if (!doc.exists) return null as any;
        return doc.data()!;
      },
      `createAppointment.slot(${slotId})`
    );
    if (!slotResult) {
      res.status(404).json({ error: 'Slot not found' });
      return;
    }

    const slotData = slotResult;

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

    const firestoreId = db.collection('Clients').doc(uid).collection('appointments').doc().id;
    const clientId = await resolveSupabaseClientId(uid);

    if (clientId) {
      const supabaseData = mapAppointmentToSupabase(clientId, firestoreId, newAppointment);
      await supabaseInsertThenFirestore({
        table: 'appointments',
        supabaseData,
        firestoreWrite: async () => {
          await db.collection('Clients').doc(uid).collection('appointments').doc(firestoreId).set(newAppointment);
        },
        context: 'appointments.create',
      });
    } else {
      await db.collection('Clients').doc(uid).collection('appointments').doc(firestoreId).set(newAppointment);
    }

    res.status(201).json({ appointmentId: firestoreId, ...newAppointment });
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
    const updatedAt = new Date();

    const supabaseUpdates: Record<string, any> = { updated_at: updatedAt.toISOString() };
    if (updates.status) supabaseUpdates.status = updates.status;
    if (updates.notes !== undefined) supabaseUpdates.notes = updates.notes;
    if (updates.date) supabaseUpdates.date = updates.date;
    if (updates.time) supabaseUpdates.time = updates.time;

    await supabaseUpdateThenFirestore({
      table: 'appointments',
      supabaseData: supabaseUpdates,
      matchColumn: 'firestore_id',
      matchValue: appointmentId,
      firestoreWrite: async () => {
        await db.collection('Clients').doc(uid).collection('appointments').doc(appointmentId)
          .update({ ...updates, updatedAt });
      },
      context: 'appointments.update',
    });

    res.json({ appointmentId, ...updates, updatedAt });
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

    await supabaseUpdateThenFirestore({
      table: 'appointments',
      supabaseData: { status: 'cancelled', updated_at: cancelledAt.toISOString() },
      matchColumn: 'firestore_id',
      matchValue: appointmentId,
      firestoreWrite: async () => {
        await db.collection('Clients').doc(uid).collection('appointments').doc(appointmentId)
          .update({ status: 'cancelled', updatedAt: cancelledAt });
      },
      context: 'appointments.cancel',
    });

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
      ...s,
      // Legacy aliases
      date: s.date ?? '',
      time: s.time ?? '',
      available: s.available ?? false,
      createdAt: s.created_at ?? '',
    }));

    res.json({ slots });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

