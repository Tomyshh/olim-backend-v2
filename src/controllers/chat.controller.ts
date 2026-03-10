import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { getFirestore } from '../config/firebase.js';
import { dualWriteToSupabase, resolveSupabaseClientId, mapChatConversationToSupabase, mapChatMessageToSupabase } from '../services/dualWrite.service.js';
import { supabase } from '../services/supabase.service.js';

export async function getConversations(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const clientId = await resolveSupabaseClientId(uid);
    if (!clientId) { res.json({ conversations: [] }); return; }

    const { data: conversations, error } = await supabase
      .from('chat_conversations')
      .select('*')
      .eq('client_id', clientId)
      .order('updated_at', { ascending: false });

    if (error) throw error;

    const enrichedConversations = await Promise.all(
      (conversations || []).map(async (conv) => {
        const { data: lastMessages } = await supabase
          .from('chat_messages')
          .select('*')
          .eq('conversation_id', conv.id)
          .order('created_at', { ascending: false })
          .limit(1);

        const { count: unreadCount } = await supabase
          .from('chat_messages')
          .select('*', { count: 'exact', head: true })
          .eq('conversation_id', conv.id)
          .eq('is_read', false)
          .neq('sender_id', uid);

        return {
          conversationId: conv.firestore_id || conv.id,
          ...conv,
          lastMessage: lastMessages?.[0] || null,
          unreadCount: unreadCount || 0
        };
      })
    );

    res.json({ conversations: enrichedConversations });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function getMessages(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const { conversationId } = req.params;
    const { limit = 50 } = req.query;

    const { data: convo } = await supabase
      .from('chat_conversations')
      .select('id')
      .or(`firestore_id.eq.${conversationId},id.eq.${conversationId}`)
      .single();

    if (!convo) { res.status(404).json({ error: 'Conversation not found' }); return; }

    const { data, error } = await supabase
      .from('chat_messages')
      .select('*')
      .eq('conversation_id', convo.id)
      .order('created_at', { ascending: true })
      .limit(Number(limit));

    if (error) throw error;

    const messages = (data || []).map(msg => ({
      messageId: msg.firestore_id || msg.id,
      ...msg
    }));

    res.json({ messages });
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

