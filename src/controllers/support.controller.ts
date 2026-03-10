import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { getFirestore } from '../config/firebase.js';
import { supabase } from '../services/supabase.service.js';
import { dualWriteToSupabase, resolveSupabaseClientId, mapSupportTicketToSupabase, mapContactMessageToSupabase } from '../services/dualWrite.service.js';

export async function getFAQs(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { data, error } = await supabase
      .from('faqs')
      .select('*')
      .order('order', { ascending: true });

    if (error) throw error;

    const faqs = (data || []).map((f: any) => ({
      faqId: f.id,
      ...f,
      // Legacy aliases
      question: f.question ?? '',
      answer: f.answer ?? '',
      category: f.category ?? '',
      displayOrder: f.display_order ?? f.order ?? 0,
      createdAt: f.created_at ?? '',
    }));

    res.json({ faqs });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function getSupportContacts(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { data, error } = await supabase
      .from('support_contacts')
      .select('*');

    if (error) throw error;

    const contacts = (data || []).map((c: any) => ({
      contactId: c.id,
      ...c,
      // Legacy aliases
      name: c.name ?? '',
      role: c.role ?? '',
      email: c.email ?? '',
      phone: c.phone ?? '',
      createdAt: c.created_at ?? '',
    }));

    res.json({ contacts });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function sendContactMessage(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { name, email, phone, subject, message } = req.body;
    const uid = req.uid || null;
    const db = getFirestore();

    const messageData = {
      uid: uid || null,
      name,
      email,
      phone: phone || null,
      subject,
      message,
      createdAt: new Date(),
      status: 'new'
    };
    const messageRef = await db.collection('ContactMessages').add(messageData);

    dualWriteToSupabase('contact_messages', mapContactMessageToSupabase(messageRef.id, messageData), { mode: 'insert' }).catch(() => {});

    res.status(201).json({
      messageId: messageRef.id,
      message: 'Contact message sent'
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function getSupportTickets(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const clientId = await resolveSupabaseClientId(uid);

    const { data, error } = await supabase
      .from('support_tickets')
      .select('*')
      .eq('client_id', clientId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    const tickets = (data || []).map((t: any) => ({
      ticketId: t.id,
      ...t,
      // Legacy aliases
      subject: t.subject ?? '',
      description: t.description ?? '',
      status: t.status ?? '',
      priority: t.priority ?? 'normal',
      createdAt: t.created_at ?? '',
      updatedAt: t.updated_at ?? '',
    }));

    res.json({ tickets });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function createSupportTicket(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const { subject, description, priority = 'normal' } = req.body;
    const db = getFirestore();

    const ticketRef = await db
      .collection('Clients')
      .doc(uid)
      .collection('support_tickets')
      .add({
        subject,
        description,
        priority,
        status: 'open',
        createdAt: new Date(),
        updatedAt: new Date()
      });

    // Créer copie admin
    await db.collection('SupportTickets').doc(ticketRef.id).set({
      uid,
      subject,
      description,
      priority,
      status: 'open',
      createdAt: new Date(),
      updatedAt: new Date()
    });

    resolveSupabaseClientId(uid).then(clientId => {
      dualWriteToSupabase('support_tickets', mapSupportTicketToSupabase(clientId, ticketRef.id, uid, {
        subject, description, priority, status: 'open', createdAt: new Date(), updatedAt: new Date()
      }), { mode: 'insert' });
    }).catch(() => {});

    res.status(201).json({
      ticketId: ticketRef.id,
      subject,
      description,
      status: 'open'
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function getSupportTicketDetail(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const { ticketId } = req.params;
    const clientId = await resolveSupabaseClientId(uid);

    const { data, error } = await supabase
      .from('support_tickets')
      .select('*')
      .eq('client_id', clientId)
      .eq('id', ticketId)
      .maybeSingle();

    if (error) throw error;

    if (!data) {
      res.status(404).json({ error: 'Support ticket not found' });
      return;
    }

    res.json({
      ticketId: data.id,
      ...data,
      // Legacy aliases
      subject: data.subject ?? '',
      description: data.description ?? '',
      status: data.status ?? '',
      priority: data.priority ?? 'normal',
      createdAt: data.created_at ?? '',
      updatedAt: data.updated_at ?? '',
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function updateSupportTicket(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const { ticketId } = req.params;
    const updates = req.body;
    const db = getFirestore();

    await db
      .collection('Clients')
      .doc(uid)
      .collection('support_tickets')
      .doc(ticketId)
      .update({
        ...updates,
        updatedAt: new Date()
      });

    // Mettre à jour copie admin
    await db.collection('SupportTickets').doc(ticketId).update({
      ...updates,
      updatedAt: new Date()
    });

    dualWriteToSupabase('support_tickets', {
      ...updates,
      updated_at: new Date().toISOString()
    }, { mode: 'update', matchColumn: 'firestore_id', matchValue: ticketId }).catch(() => {});

    res.json({ message: 'Support ticket updated', ticketId });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

