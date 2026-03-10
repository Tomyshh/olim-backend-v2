import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { getFirestore } from '../config/firebase.js';
import { dualWriteToSupabase, resolveSupabaseClientId, mapChatConversationToSupabase, mapChatMessageToSupabase } from '../services/dualWrite.service.js';
import { supabase } from '../services/supabase.service.js';

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
    const {
      requestId,
      title,
      subject,
      message,
      initialMessage
    } = req.body || {};
    const db = getFirestore();
    const conversationTitle = title || subject || 'Nouvelle conversation';

    const convoData = {
      requestId: requestId || null,
      title: conversationTitle,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const conversationRef = await db
      .collection('Clients')
      .doc(uid)
      .collection('Conversations')
      .add(convoData);

    const firstMessage = (message || initialMessage || '').toString().trim();
    if (firstMessage) {
      const clientDoc = await db.collection('Clients').doc(uid).get();
      const clientData = clientDoc.data() || {};
      await conversationRef.collection('Messages').add({
        senderId: uid,
        senderName: `${clientData['First Name'] || ''} ${clientData['Last Name'] || ''}`.trim(),
        content: firstMessage,
        type: 'text',
        attachments: [],
        read: false,
        createdAt: new Date()
      });
    }

    resolveSupabaseClientId(uid).then(cid => {
      if (cid) dualWriteToSupabase('chat_conversations', mapChatConversationToSupabase(cid, conversationRef.id, convoData), { onConflict: 'firestore_id' });
    }).catch(() => {});

    res.status(201).json({
      conversationId: conversationRef.id,
      requestId,
      title: conversationTitle
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function sendMessage(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const { conversationId } = req.params;
    const { content, message, type = 'text', attachments } = req.body || {};
    const db = getFirestore();
    const messageContent = (content || message || '').toString();
    if (!messageContent.trim()) {
      res.status(400).json({ error: 'Message content is required' });
      return;
    }

    // Récupérer infos client
    const clientDoc = await db.collection('Clients').doc(uid).get();
    const clientData = clientDoc.data()!;

    const msgData = {
      senderId: uid,
      senderName: `${clientData['First Name']} ${clientData['Last Name']}`,
      content: messageContent,
      type,
      attachments: attachments || [],
      read: false,
      createdAt: new Date()
    };

    const messageRef = await db
      .collection('Clients')
      .doc(uid)
      .collection('Conversations')
      .doc(conversationId)
      .collection('Messages')
      .add(msgData);

    const convoUpdateTime = new Date();

    // Mettre à jour conversation
    await db
      .collection('Clients')
      .doc(uid)
      .collection('Conversations')
      .doc(conversationId)
      .update({
        updatedAt: convoUpdateTime
      });

    resolveSupabaseClientId(uid).then(async (cid) => {
      if (!cid) return;
      const { data: convoRow } = await supabase.from('chat_conversations').select('id').eq('firestore_id', conversationId).maybeSingle();
      if (convoRow?.id) {
        dualWriteToSupabase('chat_messages', mapChatMessageToSupabase(convoRow.id, messageRef.id, msgData), { onConflict: 'firestore_id' }).catch(() => {});
        dualWriteToSupabase('chat_conversations', { updated_at: convoUpdateTime.toISOString() }, { mode: 'update', matchColumn: 'firestore_id', matchValue: conversationId }).catch(() => {});
      }
    }).catch(() => {});

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
    const readAt = new Date();
    unreadMessages.docs.forEach(doc => {
      batch.update(doc.ref, { read: true, readAt });
    });
    await batch.commit();

    if (unreadMessages.size > 0) {
      const messageFirestoreIds = unreadMessages.docs.map(d => d.id);
      Promise.resolve(
        supabase.from('chat_messages')
          .update({ is_read: true, read_at: readAt.toISOString() })
          .in('firestore_id', messageFirestoreIds)
      ).catch(() => {});
    }

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

