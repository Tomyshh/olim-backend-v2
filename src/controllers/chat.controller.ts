import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { getFirestore } from '../config/firebase.js';

export async function getConversations(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const db = getFirestore();

    // Nouvelle structure: Clients/{uid}/Conversations
    const conversationsSnapshot = await db
      .collection('Clients')
      .doc(uid)
      .collection('Conversations')
      .get();

    const conversations = await Promise.all(
      conversationsSnapshot.docs.map(async (doc) => {
        const convData = doc.data();
        // Récupérer dernier message
        const lastMessageSnapshot = await db
          .collection('Clients')
          .doc(uid)
          .collection('Conversations')
          .doc(doc.id)
          .collection('Messages')
          .orderBy('createdAt', 'desc')
          .limit(1)
          .get();

        const lastMessage = lastMessageSnapshot.docs[0]?.data();

        // Compter messages non lus
        const unreadSnapshot = await db
          .collection('Clients')
          .doc(uid)
          .collection('Conversations')
          .doc(doc.id)
          .collection('Messages')
          .where('read', '==', false)
          .where('senderId', '!=', uid)
          .get();

        return {
          conversationId: doc.id,
          ...convData,
          lastMessage,
          unreadCount: unreadSnapshot.size
        };
      })
    );

    res.json({ conversations });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function getMessages(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const { conversationId } = req.params;
    const { limit = 50 } = req.query;
    const db = getFirestore();

    const messagesSnapshot = await db
      .collection('Clients')
      .doc(uid)
      .collection('Conversations')
      .doc(conversationId)
      .collection('Messages')
      .orderBy('createdAt', 'desc')
      .limit(Number(limit))
      .get();

    const messages = messagesSnapshot.docs.map(doc => ({
      messageId: doc.id,
      ...doc.data()
    }));

    res.json({ messages: messages.reverse() });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function createConversation(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const { requestId, title } = req.body;
    const db = getFirestore();

    const conversationRef = await db
      .collection('Clients')
      .doc(uid)
      .collection('Conversations')
      .add({
        requestId: requestId || null,
        title: title || 'Nouvelle conversation',
        createdAt: new Date(),
        updatedAt: new Date()
      });

    res.status(201).json({
      conversationId: conversationRef.id,
      requestId,
      title
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function sendMessage(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const { conversationId } = req.params;
    const { content, type = 'text', attachments } = req.body;
    const db = getFirestore();

    // Récupérer infos client
    const clientDoc = await db.collection('Clients').doc(uid).get();
    const clientData = clientDoc.data()!;

    const messageRef = await db
      .collection('Clients')
      .doc(uid)
      .collection('Conversations')
      .doc(conversationId)
      .collection('Messages')
      .add({
        senderId: uid,
        senderName: `${clientData['First Name']} ${clientData['Last Name']}`,
        content,
        type,
        attachments: attachments || [],
        read: false,
        createdAt: new Date()
      });

    // Mettre à jour conversation
    await db
      .collection('Clients')
      .doc(uid)
      .collection('Conversations')
      .doc(conversationId)
      .update({
        updatedAt: new Date()
      });

    const messageDoc = await messageRef.get();
    res.status(201).json({ messageId: messageRef.id, ...messageDoc.data() });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function markAsRead(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const { conversationId } = req.params;
    const db = getFirestore();

    // Marquer tous les messages non lus comme lus
    const unreadMessages = await db
      .collection('Clients')
      .doc(uid)
      .collection('Conversations')
      .doc(conversationId)
      .collection('Messages')
      .where('read', '==', false)
      .where('senderId', '!=', uid)
      .get();

    const batch = db.batch();
    unreadMessages.docs.forEach(doc => {
      batch.update(doc.ref, { read: true, readAt: new Date() });
    });
    await batch.commit();

    res.json({ message: 'Messages marked as read', count: unreadMessages.size });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function uploadChatFile(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const { conversationId } = req.params;
    // TODO: Implémenter upload fichier avec Firebase Storage
    // TODO: Retourner URL du fichier

    res.status(501).json({
      message: 'Not implemented - uploadChatFile',
      note: 'À implémenter avec Firebase Storage'
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

