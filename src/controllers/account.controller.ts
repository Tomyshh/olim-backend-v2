import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { getFirestore, getAuth } from '../config/firebase.js';
import { supabase } from '../services/supabase.service.js';
import { resolveSupabaseClientId } from '../services/dualWrite.service.js';

function serializeFirestoreValue(val: unknown): unknown {
  if (val === null || val === undefined) return val;
  if (val instanceof Date) return val.toISOString();
  if (typeof (val as any).toDate === 'function') return (val as any).toDate().toISOString();
  if (Array.isArray(val)) return val.map(serializeFirestoreValue);
  if (val && typeof val === 'object' && !(val instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val)) {
      out[k] = serializeFirestoreValue(v);
    }
    return out;
  }
  return val;
}

async function exportCollectionRecursive(
  db: FirebaseFirestore.Firestore,
  colRef: FirebaseFirestore.CollectionReference,
  output: Record<string, unknown[]>
): Promise<void> {
  const snapshot = await colRef.get();
  const docs: Record<string, unknown>[] = [];
  for (const doc of snapshot.docs) {
    const data = doc.data();
    const serialized: Record<string, unknown> = { id: doc.id };
    for (const [k, v] of Object.entries(data)) {
      serialized[k] = serializeFirestoreValue(v);
    }
    // Check for subcollections (e.g. Conversations -> Messages)
    const subCols = await doc.ref.listCollections();
    if (subCols.length > 0) {
      const subData: Record<string, unknown[]> = {};
      for (const subCol of subCols) {
        const subDocs: Record<string, unknown>[] = [];
        const subSnap = await subCol.get();
        for (const subDoc of subSnap.docs) {
          const sd = subDoc.data();
          const ser: Record<string, unknown> = { id: subDoc.id };
          for (const [sk, sv] of Object.entries(sd)) {
            ser[sk] = serializeFirestoreValue(sv);
          }
          subDocs.push(ser);
        }
        subData[subCol.id] = subDocs;
      }
      (serialized as any)._subcollections = subData;
    }
    docs.push(serialized);
  }
  output[colRef.id] = docs;
}

export async function exportUserData(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const db = getFirestore();
    const clientRef = db.collection('Clients').doc(uid);
    const clientDoc = await clientRef.get();

    if (!clientDoc.exists) {
      res.status(404).json({ error: 'Client not found' });
      return;
    }

    const clientData = clientDoc.data() ?? {};
    const serializedClient: Record<string, unknown> = { id: clientDoc.id };
    for (const [k, v] of Object.entries(clientData)) {
      serializedClient[k] = serializeFirestoreValue(v);
    }

    const result: Record<string, unknown> = {
      client: serializedClient,
      subcollections: {} as Record<string, unknown[]>,
    };

    const collections = await clientRef.listCollections();
    for (const col of collections) {
      await exportCollectionRecursive(db, col, result.subcollections as Record<string, unknown[]>);
    }

    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

async function deleteFirestoreSubcollections(
  db: FirebaseFirestore.Firestore,
  clientRef: FirebaseFirestore.DocumentReference
): Promise<void> {
  const collections = await clientRef.listCollections();
  for (const col of collections) {
    const snapshot = await col.get();
    const batch = db.batch();
    for (const doc of snapshot.docs) {
      const subCols = await doc.ref.listCollections();
      for (const subCol of subCols) {
        const subSnap = await subCol.get();
        for (const subDoc of subSnap.docs) {
          batch.delete(subDoc.ref);
        }
      }
      batch.delete(doc.ref);
    }
    if (snapshot.size > 0) await batch.commit();
  }
}

export async function deleteAccount(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const db = getFirestore();
    const auth = getAuth();
    const clientRef = db.collection('Clients').doc(uid);

    // 1. Delete all Firestore subcollections and documents
    await deleteFirestoreSubcollections(db, clientRef);
    await clientRef.delete();

    // 2. Delete from Supabase (dual write cleanup)
    const clientId = await resolveSupabaseClientId(uid);
    if (clientId) {
      const tablesByClientId = [
        'chat_messages', // via conversation_id - need to get conv ids first
        'chat_conversations',
        'client_document_files', // via client_document_id
        'client_documents',
        'client_addresses',
        'client_devices',
        'client_fcm_tokens',
        'client_phones',
        'family_members',
        'payment_credentials',
        'subscription_events',
        'promo_redemptions',
        'subscriptions',
        'notifications',
        'notification_settings',
        'appointments',
        'favorite_requests',
        'request_drafts',
        'support_tickets',
        'health_requests',
        'refund_requests',
        'subscription_change_quotes',
        'health_configs',
      ];

      // Chat: delete messages first (by conversation_id)
      const { data: convs } = await supabase
        .from('chat_conversations')
        .select('id')
        .eq('client_id', clientId);
      const convIds = (convs ?? []).map((c: any) => c.id);
      if (convIds.length > 0) {
        for (let i = 0; i < convIds.length; i += 100) {
          const chunk = convIds.slice(i, i + 100);
          await supabase.from('chat_messages').delete().in('conversation_id', chunk);
        }
      }
      await supabase.from('chat_conversations').delete().eq('client_id', clientId);

      // Client documents: delete files first
      const { data: docIds } = await supabase
        .from('client_documents')
        .select('id')
        .eq('client_id', clientId);
      const cdocIds = (docIds ?? []).map((d: any) => d.id);
      if (cdocIds.length > 0) {
        for (let i = 0; i < cdocIds.length; i += 100) {
          const chunk = cdocIds.slice(i, i + 100);
          await supabase.from('client_document_files').delete().in('client_document_id', chunk);
        }
      }

      await supabase.from('client_documents').delete().eq('client_id', clientId);
      await supabase.from('client_addresses').delete().eq('client_id', clientId);
      await supabase.from('client_devices').delete().eq('client_id', clientId);
      await supabase.from('client_fcm_tokens').delete().eq('client_id', clientId);
      await supabase.from('client_phones').delete().eq('client_id', clientId);
      await supabase.from('family_members').delete().eq('client_id', clientId);
      await supabase.from('payment_credentials').delete().eq('client_id', clientId);
      await supabase.from('subscription_events').delete().eq('client_id', clientId);
      await supabase.from('promo_redemptions').delete().eq('client_id', clientId);
      await supabase.from('subscriptions').delete().eq('client_id', clientId);
      await supabase.from('notifications').delete().eq('client_id', clientId);
      try {
        await supabase.from('notification_settings').delete().eq('client_id', clientId);
      } catch {}
      await supabase.from('appointments').delete().eq('client_id', clientId);
      await supabase.from('favorite_requests').delete().eq('client_id', clientId);
      await supabase.from('request_drafts').delete().eq('client_id', clientId);
      try {
        await supabase.from('support_tickets').delete().eq('client_id', clientId);
      } catch {}
      try {
        await supabase.from('health_requests').delete().eq('client_id', clientId);
      } catch {}
      try {
        await supabase.from('refund_requests').delete().eq('client_id', clientId);
      } catch {}
      try {
        await supabase.from('subscription_change_quotes').delete().eq('client_id', clientId);
      } catch {}
      try {
        await supabase.from('health_configs').delete().eq('client_id', clientId);
      } catch {}

      // Nullify requests.client_id (requests may reference client)
      await supabase.from('requests').update({ client_id: null }).eq('client_id', clientId);

      // Delete client
      await supabase.from('clients').delete().eq('id', clientId);
    }

    // Delete by firebase_uid for tables that may have it without client_id
    await supabase.from('support_tickets').delete().eq('client_firebase_uid', uid);
    await supabase.from('health_requests').delete().eq('client_firebase_uid', uid);
    await supabase.from('clients').delete().eq('firebase_uid', uid);

    // 3. Delete Firebase Auth user
    await auth.deleteUser(uid);

    res.json({ message: 'Account deleted successfully' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}
