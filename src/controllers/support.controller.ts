import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { getFirestore } from '../config/firebase.js';
import { dualWriteToSupabase, resolveSupabaseClientId, mapSupportTicketToSupabase, mapContactMessageToSupabase } from '../services/dualWrite.service.js';

export async function getFAQs(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const db = getFirestore();
    const faqsSnapshot = await db.collection('FAQs').orderBy('order', 'asc').get();

    const faqs = faqsSnapshot.docs.map(doc => ({
      faqId: doc.id,
      ...doc.data()
    }));

    res.json({ faqs });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function getSupportContacts(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const db = getFirestore();
    const contactsSnapshot = await db.collection('SupportContacts').get();

    const contacts = contactsSnapshot.docs.map(doc => ({
      contactId: doc.id,
      ...doc.data()
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
    const db = getFirestore();

    const ticketsSnapshot = await db
      .collection('Clients')
      .doc(uid)
      .collection('support_tickets')
      .orderBy('createdAt', 'desc')
      .get();

    const tickets = ticketsSnapshot.docs.map(doc => ({
      ticketId: doc.id,
      ...doc.data()
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
    const db = getFirestore();

    const ticketDoc = await db
      .collection('Clients')
      .doc(uid)
      .collection('support_tickets')
      .doc(ticketId)
      .get();

    if (!ticketDoc.exists) {
      res.status(404).json({ error: 'Support ticket not found' });
      return;
    }

    res.json({ ticketId, ...ticketDoc.data() });
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

