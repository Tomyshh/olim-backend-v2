import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { getFirestore } from '../config/firebase.js';
import { dualWriteToSupabase, resolveSupabaseClientId, mapChatConversationToSupabase, mapChatMessageToSupabase } from '../services/dualWrite.service.js';
import { supabase } from '../services/supabase.service.js';
import { uploadDual, sanitizeFilename, inferContentType } from '../services/storage.service.js';
import { readClientInfo } from '../services/supabaseFirstRead.service.js';
import { supabaseInsertThenFirestore } from '../services/supabaseFirstWrite.service.js';

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

    if (error) {
      console.error('[chat] getConversations Supabase error:', error.message);
      // Fallback Firestore
      try {
        const db = getFirestore();
        const snap = await db
          .collection('Clients').doc(uid)
          .collection('Conversations')
          .orderBy('updatedAt', 'desc')
          .get();
        const fallback = snap.docs.map(d => {
          const data = d.data();
          return {
            conversationId: d.id,
            title: data.title ?? '',
            requestId: data.requestId ?? null,
            createdAt: data.createdAt ?? '',
            updatedAt: data.updatedAt ?? '',
            lastMessage: null,
            unreadCount: 0,
          };
        });
        res.json({ conversations: fallback });
        return;
      } catch (fbErr: any) {
        console.error('[chat] Firestore fallback also failed:', fbErr.message);
        res.json({ conversations: [] });
        return;
      }
    }

    const enrichedConversations = await Promise.all(
      (conversations || []).map(async (conv) => {
        let lastMsg: any = null;
        let unreadCount = 0;
        try {
          const { data: lastMessages } = await supabase
            .from('chat_messages')
            .select('*')
            .eq('conversation_id', conv.id)
            .order('created_at', { ascending: false })
            .limit(1);
          lastMsg = lastMessages?.[0] || null;

          const { count } = await supabase
            .from('chat_messages')
            .select('*', { count: 'exact', head: true })
            .eq('conversation_id', conv.id)
            .eq('is_read', false)
            .neq('sender_id', uid);
          unreadCount = count || 0;
        } catch (_) {
          // Non-blocking: return conversation without message details
        }

        return {
          conversationId: conv.firestore_id || conv.id,
          ...conv,
          lastMessage: lastMsg ? {
            ...lastMsg,
            senderName: lastMsg.sender_name ?? '',
            senderId: lastMsg.sender_id ?? '',
            isRead: lastMsg.is_read ?? false,
            readAt: lastMsg.read_at ?? null,
            createdAt: lastMsg.created_at ?? '',
          } : null,
          unreadCount,
          title: conv.title ?? '',
          requestId: conv.request_id ?? null,
          createdAt: conv.created_at ?? '',
          updatedAt: conv.updated_at ?? '',
        };
      })
    );

    res.json({ conversations: enrichedConversations });
  } catch (error: any) {
    console.error('[chat] getConversations unexpected error:', error.message);
    res.json({ conversations: [] });
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
      ...msg,
      // Legacy aliases
      content: msg.content ?? '',
      senderName: msg.sender_name ?? '',
      senderId: msg.sender_id ?? '',
      type: msg.type ?? 'text',
      attachments: msg.attachments ?? [],
      isRead: msg.is_read ?? false,
      readAt: msg.read_at ?? null,
      createdAt: msg.created_at ?? '',
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

    const firestoreConvoId = db.collection('Clients').doc(uid).collection('Conversations').doc().id;
    const clientId = await resolveSupabaseClientId(uid);

    if (clientId) {
      const supabaseConvo = mapChatConversationToSupabase(clientId, firestoreConvoId, convoData);
      await supabaseInsertThenFirestore({
        table: 'chat_conversations',
        supabaseData: supabaseConvo,
        firestoreWrite: async () => {
          await db.collection('Clients').doc(uid).collection('Conversations').doc(firestoreConvoId).set(convoData);
        },
        context: 'chat.createConversation',
      });
    } else {
      await db.collection('Clients').doc(uid).collection('Conversations').doc(firestoreConvoId).set(convoData);
    }

    const firstMessage = (message || initialMessage || '').toString().trim();
    if (firstMessage) {
      const clientData = await readClientInfo(uid, async () => {
        const doc = await db.collection('Clients').doc(uid).get();
        return doc.data() || {};
      });
      const msgData = {
        senderId: uid,
        senderName: `${clientData['First Name'] || ''} ${clientData['Last Name'] || ''}`.trim(),
        content: firstMessage,
        type: 'text',
        attachments: [],
        read: false,
        createdAt: new Date()
      };
      const firestoreMsgId = db.collection('Clients').doc(uid).collection('Conversations').doc(firestoreConvoId).collection('Messages').doc().id;

      if (clientId) {
        const { data: convoRow } = await supabase.from('chat_conversations').select('id').eq('firestore_id', firestoreConvoId).maybeSingle();
        if (convoRow?.id) {
          await supabaseInsertThenFirestore({
            table: 'chat_messages',
            supabaseData: mapChatMessageToSupabase(convoRow.id, firestoreMsgId, msgData),
            firestoreWrite: async () => {
              await db.collection('Clients').doc(uid).collection('Conversations').doc(firestoreConvoId).collection('Messages').doc(firestoreMsgId).set(msgData);
            },
            context: 'chat.createConversation.firstMessage',
          });
        } else {
          await db.collection('Clients').doc(uid).collection('Conversations').doc(firestoreConvoId).collection('Messages').doc(firestoreMsgId).set(msgData);
        }
      } else {
        await db.collection('Clients').doc(uid).collection('Conversations').doc(firestoreConvoId).collection('Messages').doc(firestoreMsgId).set(msgData);
      }
    }

    res.status(201).json({
      conversationId: firestoreConvoId,
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

    const clientData = await readClientInfo(uid, async () => {
      const doc = await db.collection('Clients').doc(uid).get();
      return doc.data() || {};
    });

    const msgData = {
      senderId: uid,
      senderName: `${clientData['First Name'] || ''} ${clientData['Last Name'] || ''}`.trim(),
      content: messageContent,
      type,
      attachments: attachments || [],
      read: false,
      createdAt: new Date()
    };

    const firestoreMsgId = db.collection('Clients').doc(uid).collection('Conversations').doc(conversationId).collection('Messages').doc().id;
    const convoUpdateTime = new Date();

    const { data: convoRow } = await supabase.from('chat_conversations').select('id').eq('firestore_id', conversationId).maybeSingle();

    if (convoRow?.id) {
      await supabaseInsertThenFirestore({
        table: 'chat_messages',
        supabaseData: mapChatMessageToSupabase(convoRow.id, firestoreMsgId, msgData),
        firestoreWrite: async () => {
          await db.collection('Clients').doc(uid).collection('Conversations').doc(conversationId).collection('Messages').doc(firestoreMsgId).set(msgData);
          await db.collection('Clients').doc(uid).collection('Conversations').doc(conversationId).update({ updatedAt: convoUpdateTime });
        },
        context: 'chat.sendMessage',
      });
      Promise.resolve(supabase.from('chat_conversations').update({ updated_at: convoUpdateTime.toISOString() }).eq('firestore_id', conversationId)).catch(() => {});
    } else {
      await db.collection('Clients').doc(uid).collection('Conversations').doc(conversationId).collection('Messages').doc(firestoreMsgId).set(msgData);
      await db.collection('Clients').doc(uid).collection('Conversations').doc(conversationId).update({ updatedAt: convoUpdateTime });
    }

    res.status(201).json({ messageId: firestoreMsgId, ...msgData });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function markAsRead(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const { conversationId } = req.params;
    const db = getFirestore();
    const readAt = new Date();

    // Supabase-first: mark unread messages as read
    const { data: convo } = await supabase
      .from('chat_conversations')
      .select('id')
      .or(`firestore_id.eq.${conversationId},id.eq.${conversationId}`)
      .maybeSingle();

    let count = 0;

    if (convo?.id) {
      const { data: unreadMessages } = await supabase
        .from('chat_messages')
        .select('id, firestore_id')
        .eq('conversation_id', convo.id)
        .eq('is_read', false)
        .neq('sender_id', uid);

      if (unreadMessages && unreadMessages.length > 0) {
        count = unreadMessages.length;
        const ids = unreadMessages.map((m: any) => m.id);
        await supabase
          .from('chat_messages')
          .update({ is_read: true, read_at: readAt.toISOString() })
          .in('id', ids);

        // Firestore best-effort sync
        try {
          const firestoreIds = unreadMessages
            .map((m: any) => m.firestore_id)
            .filter(Boolean);
          if (firestoreIds.length > 0) {
            const batch = db.batch();
            for (const fid of firestoreIds) {
              const ref = db
                .collection('Clients')
                .doc(uid)
                .collection('Conversations')
                .doc(conversationId)
                .collection('Messages')
                .doc(fid);
              batch.update(ref, { read: true, readAt });
            }
            await batch.commit();
          }
        } catch (firestoreErr) {
          console.warn('[chat.markAsRead] Firestore sync failed (best-effort)', firestoreErr);
        }
      }
    } else {
      // Fallback: Firestore if conversation not found in Supabase
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
        batch.update(doc.ref, { read: true, readAt });
      });
      await batch.commit();
      count = unreadMessages.size;

      if (unreadMessages.size > 0) {
        const messageFirestoreIds = unreadMessages.docs.map(d => d.id);
        Promise.resolve(
          supabase.from('chat_messages')
            .update({ is_read: true, read_at: readAt.toISOString() })
            .in('firestore_id', messageFirestoreIds)
        ).catch(() => {});
      }
    }

    res.json({ message: 'Messages marked as read', count });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function uploadChatFile(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const { conversationId } = req.params;

    const files = (req as any).files as Express.Multer.File[] | undefined;
    const file = files?.[0] || (req as any).file as Express.Multer.File | undefined;
    if (!file) {
      res.status(400).json({ message: 'Aucun fichier reçu.' });
      return;
    }

    const { data: convo } = await supabase
      .from('chat_conversations')
      .select('id')
      .or(`firestore_id.eq.${conversationId},id.eq.${conversationId}`)
      .single();

    if (!convo) {
      res.status(404).json({ error: 'Conversation introuvable.' });
      return;
    }

    const originalName = String(file.originalname || 'file');
    const clean = sanitizeFilename(originalName);
    const ts = Date.now();
    const contentType = inferContentType(originalName, file.mimetype);

    const result = await uploadDual({
      bucket: 'chat-files',
      firebasePath: `chats/${conversationId}/${ts}_${clean}`,
      supabasePath: `${convo.id}/${ts}_${clean}`,
      buffer: file.buffer,
      contentType,
      originalName,
      size: file.size || 0,
      uploaderId: uid,
    });

    const db = getFirestore();
    const clientData = await readClientInfo(uid, async () => {
      const doc = await db.collection('Clients').doc(uid).get();
      return doc.data() || {};
    });

    const attachment = {
      url: result.firebaseUrl,
      supabaseStoragePath: result.supabasePath,
      name: originalName,
      contentType,
      size: result.size,
    };

    const msgData = {
      senderId: uid,
      senderName: `${clientData['First Name'] || ''} ${clientData['Last Name'] || ''}`.trim(),
      content: '',
      type: 'file',
      attachments: [attachment],
      read: false,
      createdAt: new Date(),
    };

    const messageRef = await db
      .collection('Clients')
      .doc(uid)
      .collection('Conversations')
      .doc(conversationId)
      .collection('Messages')
      .add(msgData);

    await db
      .collection('Clients')
      .doc(uid)
      .collection('Conversations')
      .doc(conversationId)
      .update({ updatedAt: new Date() });

    resolveSupabaseClientId(uid).then(async (cid) => {
      if (!cid) return;
      const { data: convoRow } = await supabase
        .from('chat_conversations')
        .select('id')
        .eq('firestore_id', conversationId)
        .maybeSingle();
      if (convoRow?.id) {
        dualWriteToSupabase('chat_messages', mapChatMessageToSupabase(convoRow.id, messageRef.id, msgData), { onConflict: 'firestore_id' }).catch(() => {});
      }
    }).catch(() => {});

    res.status(201).json({
      messageId: messageRef.id,
      file: {
        url: result.firebaseUrl,
        supabaseStoragePath: result.supabasePath,
        originalName,
        contentType,
        size: result.size,
      },
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

