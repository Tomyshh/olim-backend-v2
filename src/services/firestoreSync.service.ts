/**
 * Full Firestore → Supabase daily sync.
 * READ-ONLY on Firestore. Upserts into Supabase.
 * Designed to be idempotent and safe to run as a daily cron job.
 */

import { getFirestore } from '../config/firebase.js';
import { supabase } from './supabase.service.js';
import {
  mapClientToSupabase,
  mapSubscriptionToSupabase,
  mapAddressToSupabase,
  mapFamilyMemberToSupabase,
  mapPaymentCredentialToSupabase,
  mapLegacyRequestToSupabase,
  mapFavoriteRequestToSupabase,
  mapNotificationToSupabase,
  mapAppointmentToSupabase,
  mapAccesToSupabase,
  mapClientLogToSupabase,
  mapChatConversationToSupabase,
  mapChatMessageToSupabase,
  mapRequestDraftToSupabase,
  mapSupportTicketToSupabase,
  mapHealthRequestToSupabase,
  mapRefundRequestToSupabase,
  mapSettingsToSupabase,
  mapUserSavedTipToSupabase,
  resolveDocumentTypeId,
} from './dualWrite.service.js';

const LOG = '[firestoreSync]';

function toIso(v: unknown): string | null {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object' && 'toDate' in (v as any)) {
    try { return (v as any).toDate().toISOString(); } catch { return null; }
  }
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number') return new Date(v).toISOString();
  return null;
}

function normalizeDocTypeSlug(raw: string): string {
  const s = raw.toLowerCase().trim();
  if (s.includes('teoudat z') || s.includes('teudat z') || s === 'tz') return 'teudat_zehut';
  if (s.includes('teoudat ol')) return 'teudat_ole';
  if (s.includes('passeport') && (s.includes('etranger') || s.includes('franc'))) return 'passeport_etranger';
  if (s.includes('passeport') || s === 'passport') return 'passeport';
  if (s.includes('permis de conduire')) return 'permis_conduire';
  if (s.includes('carte de cr') || s.includes('credit card')) return 'carte_credit';
  if (s.includes("carte d'identit")) return 'carte_identite';
  if (s.includes('carte grise')) return 'carte_grise';
  if (s.includes('koupat') || s.includes('health fund')) return 'carte_koupat_holim';
  if (s.includes('contrat de location')) return 'contrat_location';
  if (s.includes('arnona')) return 'facture_arnona';
  if (s.includes('fiche de paie')) return 'fiche_paie';
  if (s.includes('relev') && s.includes('bancaire')) return 'releve_bancaire';
  if (s === 'rib') return 'rib';
  if (s.includes('profile_photo')) return 'profile_photo';
  if (s.includes('request_attachment')) return 'request_attachment';
  return 'autre';
}

interface SyncReport {
  totalClients: number;
  synced: number;
  errors: number;
  duplicatesRemoved: number;
  startedAt: string;
  completedAt?: string;
  errorDetails: string[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────

async function upsertSafe(table: string, data: Record<string, any>, onConflict: string): Promise<string | null> {
  for (const k of Object.keys(data)) {
    if (data[k] === undefined) delete data[k];
  }
  const { data: result, error } = await supabase
    .from(table)
    .upsert(data, { onConflict })
    .select('id')
    .maybeSingle();

  if (error) {
    if (!error.message?.includes('duplicate')) {
      console.warn(`${LOG} [${table}] upsert error:`, error.message);
    }
    return null;
  }
  return result?.id ?? null;
}

async function insertIgnoreDup(table: string, data: Record<string, any>): Promise<string | null> {
  for (const k of Object.keys(data)) {
    if (data[k] === undefined) delete data[k];
  }
  const { data: result, error } = await supabase
    .from(table)
    .insert(data)
    .select('id')
    .maybeSingle();

  if (error) {
    if (error.message?.includes('duplicate') || error.message?.includes('unique')) return null;
    console.warn(`${LOG} [${table}] insert error:`, error.message);
    return null;
  }
  return result?.id ?? null;
}

// ─── Generic dedup: remove rows with same (client_id, firestore_id) ──────

const TABLES_WITH_FIRESTORE_ID = [
  'client_addresses',
  'family_members',
  'payment_credentials',
  'client_documents',
  'favorite_requests',
  'chat_conversations',
  'appointments',
  'request_drafts',
  'support_tickets',
  'health_requests',
  'refund_requests',
  'client_access_credentials',
  'client_logs',
  'invoices',
  'notifications',
  'subscription_change_quotes',
] as const;

async function deduplicateByFirestoreId(table: string, clientId: string): Promise<number> {
  const { data: rows } = await supabase
    .from(table)
    .select('id, firestore_id, created_at')
    .eq('client_id', clientId)
    .order('created_at', { ascending: true });

  if (!rows || rows.length < 2) return 0;

  const seen = new Map<string, string>();
  const toDelete: string[] = [];

  for (const row of rows) {
    const fid = row.firestore_id;
    if (!fid) continue;
    if (seen.has(fid)) {
      toDelete.push(row.id);
    } else {
      seen.set(fid, row.id);
    }
  }

  if (toDelete.length > 0) {
    await supabase.from(table).delete().in('id', toDelete);
  }
  return toDelete.length;
}

async function deduplicateAddressesByContent(clientId: string): Promise<number> {
  const { data: addresses } = await supabase
    .from('client_addresses')
    .select('id, address1, apartment, floor, is_primary, created_at')
    .eq('client_id', clientId)
    .order('created_at', { ascending: true });

  if (!addresses || addresses.length < 2) return 0;

  const seen = new Map<string, typeof addresses[0]>();
  const toDelete: string[] = [];

  for (const addr of addresses) {
    const key = [
      (addr.address1 || '').toLowerCase().trim(),
      (addr.apartment || '').toLowerCase().trim(),
      (addr.floor || '').toLowerCase().trim(),
    ].join('|');

    if (!key || key === '||') continue;

    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, addr);
    } else {
      if (addr.is_primary && !existing.is_primary) {
        toDelete.push(existing.id);
        seen.set(key, addr);
      } else {
        toDelete.push(addr.id);
      }
    }
  }

  if (toDelete.length > 0) {
    await supabase.from('client_addresses').delete().in('id', toDelete);
  }
  return toDelete.length;
}

async function deduplicateAllTablesForClient(clientId: string): Promise<number> {
  let total = 0;
  for (const table of TABLES_WITH_FIRESTORE_ID) {
    try {
      total += await deduplicateByFirestoreId(table, clientId);
    } catch { /* table may not have client_id column — skip */ }
  }
  total += await deduplicateAddressesByContent(clientId);
  return total;
}

// ─── Build conseiller name→id map ─────────────────────────────────────────

async function buildConseillerMap(): Promise<{ byName: Map<string, string>; byFirstName: Map<string, string> }> {
  const { data } = await supabase.from('conseillers').select('id, name');
  const byName = new Map<string, string>();
  const byFirstName = new Map<string, string>();
  const firstNameCount = new Map<string, number>();

  if (data) {
    for (const c of data) {
      if (c.name) {
        byName.set(c.name.toLowerCase().trim(), c.id);
        const first = c.name.split(' ')[0]?.toLowerCase().trim();
        if (first) {
          firstNameCount.set(first, (firstNameCount.get(first) || 0) + 1);
          byFirstName.set(first, c.id);
        }
      }
    }
    // Remove ambiguous first names
    for (const [name, count] of firstNameCount) {
      if (count > 1) byFirstName.delete(name);
    }
  }
  return { byName, byFirstName };
}

function resolveConseillerId(
  assignedTo: string | null,
  map: { byName: Map<string, string>; byFirstName: Map<string, string> }
): string | null {
  if (!assignedTo) return null;
  const lower = assignedTo.toLowerCase().trim();
  return map.byName.get(lower) ?? map.byFirstName.get(lower.split(' ')[0] || '') ?? null;
}

// ─── Sync a single client ─────────────────────────────────────────────────

async function syncClient(
  uid: string,
  clientRef: FirebaseFirestore.DocumentReference,
  fsData: Record<string, any>,
  conseillerMap: { byName: Map<string, string>; byFirstName: Map<string, string> },
): Promise<{ duplicatesRemoved: number }> {

  // 1. Client personal info
  const clientRow = mapClientToSupabase(uid, fsData);
  const phone = fsData['Phone Number'];
  if (typeof phone === 'string') clientRow.phone = phone;
  else if (Array.isArray(phone) && phone.length > 0) clientRow.phone = phone[0];
  const clientId = await upsertSafe('clients', clientRow, 'firebase_uid');
  if (!clientId) throw new Error('Could not upsert client');

  // 2. Subscription
  try {
    const subSnap = await clientRef.collection('subscription').doc('current').get();
    if (subSnap.exists) {
      const subRow = await mapSubscriptionToSupabase(clientId, subSnap.data()!);
      await upsertSafe('subscriptions', subRow, 'client_id');
    }
  } catch (e: any) { console.warn(`${LOG}   subscription:`, e.message); }

  // 3. Addresses (upsert + dedup)
  try {
    const addrSnap = await clientRef.collection('Addresses').get();
    const hasPrimaryDoc = addrSnap.docs.some(d => d.id === 'primary');
    const onlyOne = addrSnap.docs.length === 1;

    for (const doc of addrSnap.docs) {
      const row = mapAddressToSupabase(clientId, doc.id, doc.data());
      if (!hasPrimaryDoc && onlyOne) {
        row.is_primary = true;
        row.is_current_residence = true;
      }

      const { data: existing } = await supabase
        .from('client_addresses')
        .select('id')
        .eq('client_id', clientId)
        .eq('firestore_id', doc.id)
        .maybeSingle();

      if (row.is_primary && !existing?.id) {
        await supabase
          .from('client_addresses')
          .update({ is_primary: false })
          .eq('client_id', clientId)
          .eq('is_primary', true);
      }

      if (existing?.id) {
        await supabase.from('client_addresses').update(row).eq('id', existing.id);
      } else {
        await supabase.from('client_addresses').insert(row);
      }
    }
  } catch (e: any) { console.warn(`${LOG}   addresses:`, e.message); }

  // 4. Family Members
  try {
    const famSnap = await clientRef.collection('Family Members').get();
    for (const doc of famSnap.docs) {
      const row = await mapFamilyMemberToSupabase(clientId, doc.id, doc.data());
      await upsertSafe('family_members', row, 'client_id,firestore_id');
    }
  } catch (e: any) { console.warn(`${LOG}   family_members:`, e.message); }

  // 5. Payment Credentials
  try {
    const paySnap = await clientRef.collection('Payment credentials').get();
    for (const doc of paySnap.docs) {
      const row = mapPaymentCredentialToSupabase(clientId, doc.id, doc.data());
      await upsertSafe('payment_credentials', row, 'client_id,firestore_id');
    }
  } catch (e: any) { console.warn(`${LOG}   payment_credentials:`, e.message); }

  // 6. Client Documents
  try {
    const docSnap = await clientRef.collection('Client Documents').get();
    for (const doc of docSnap.docs) {
      const d = doc.data();
      const rawDocType = d['Document Type'] || d.documentType || 'unknown';
      const docTypeSlug = normalizeDocTypeSlug(rawDocType);
      const documentTypeId = await resolveDocumentTypeId(docTypeSlug);

      const docId = await insertIgnoreDup('client_documents', {
        client_id: clientId,
        firestore_id: doc.id,
        document_type: rawDocType,
        document_type_id: documentTypeId,
        for_who: d['For who ?'] || d.forWho || null,
        uploaded_at: toIso(d['Upload date']) || toIso(d.uploadDate),
        is_valid: d.isValid ?? false,
        metadata: { firestoreId: doc.id },
        created_at: toIso(d.createdAt) ?? new Date().toISOString()
      });
      if (docId && Array.isArray(d['Uploaded Files'])) {
        for (const url of d['Uploaded Files']) {
          if (typeof url === 'string') {
            await insertIgnoreDup('client_document_files', { client_document_id: docId, url });
          }
        }
      }
    }

    // Docs/Personnels
    const persSnap = await clientRef.collection('Docs').doc('Personnels').get();
    if (persSnap.exists) {
      const d = persSnap.data()!;
      for (const [key, value] of Object.entries(d)) {
        if (!value) continue;
        const docSlug = normalizeDocTypeSlug(key);
        const docTypeId = await resolveDocumentTypeId(docSlug);
        await insertIgnoreDup('client_documents', {
          client_id: clientId,
          firestore_id: `personnels_${key}`,
          document_type: key,
          document_type_id: docTypeId,
          for_who: 'personal',
          file_url: typeof value === 'string' ? value : (value as any)?.url || null,
          metadata: typeof value === 'object' ? value as any : { value },
          created_at: new Date().toISOString()
        });
      }
    }
  } catch (e: any) { console.warn(`${LOG}   documents:`, e.message); }

  // 7. Legacy Requests (with conseiller assignment)
  try {
    const reqSnap = await clientRef.collection('Requests').get();
    for (const doc of reqSnap.docs) {
      const row = mapLegacyRequestToSupabase(uid, doc.id, doc.data());
      row.client_id = clientId;
      const assignedTo = row.assigned_to as string | null;
      row.assigned_to_conseiller_id = resolveConseillerId(assignedTo, conseillerMap);
      await supabase.from('requests').upsert(row, { onConflict: 'unique_id' });
    }
  } catch (e: any) { console.warn(`${LOG}   requests:`, e.message); }

  // 8. Favorite Requests
  try {
    const favSnap = await clientRef.collection('favoriteRequests').get();
    for (const doc of favSnap.docs) {
      const row = mapFavoriteRequestToSupabase(clientId, doc.id, doc.data());
      await upsertSafe('favorite_requests', row, 'firestore_id');
    }
  } catch (e: any) { console.warn(`${LOG}   favorites:`, e.message); }

  // 9. Conversations + Messages
  try {
    const convoSnap = await clientRef.collection('Conversations').get();
    for (const convoDoc of convoSnap.docs) {
      const convoRow = mapChatConversationToSupabase(clientId, convoDoc.id, convoDoc.data());
      const convoId = await upsertSafe('chat_conversations', convoRow, 'firestore_id');
      if (convoId) {
        const msgSnap = await convoDoc.ref.collection('Messages').get();
        for (const msgDoc of msgSnap.docs) {
          const msgRow = mapChatMessageToSupabase(convoId, msgDoc.id, msgDoc.data());
          await insertIgnoreDup('chat_messages', msgRow);
        }
      }
    }
  } catch (e: any) { console.warn(`${LOG}   conversations:`, e.message); }

  // 10. Notifications
  try {
    const notifSnap = await clientRef.collection('notifications').get();
    for (const doc of notifSnap.docs) {
      const row = mapNotificationToSupabase(clientId, doc.id, doc.data());
      await insertIgnoreDup('notifications', row);
    }
  } catch (e: any) { console.warn(`${LOG}   notifications:`, e.message); }

  // 11. Appointments
  try {
    const apptSnap = await clientRef.collection('appointments').get();
    for (const doc of apptSnap.docs) {
      const row = mapAppointmentToSupabase(clientId, doc.id, doc.data());
      await upsertSafe('appointments', row, 'firestore_id');
    }
  } catch (e: any) { console.warn(`${LOG}   appointments:`, e.message); }

  // 12. Request Drafts
  try {
    const draftSnap = await clientRef.collection('RequestDrafts').get();
    for (const doc of draftSnap.docs) {
      const row = mapRequestDraftToSupabase(clientId, doc.id, doc.data());
      await upsertSafe('request_drafts', row, 'firestore_id');
    }
  } catch (e: any) { console.warn(`${LOG}   request_drafts:`, e.message); }

  // 13. Support Tickets
  try {
    const ticketSnap = await clientRef.collection('support_tickets').get();
    for (const doc of ticketSnap.docs) {
      const row = mapSupportTicketToSupabase(clientId, doc.id, uid, doc.data());
      await insertIgnoreDup('support_tickets', row);
    }
  } catch (e: any) { console.warn(`${LOG}   support_tickets:`, e.message); }

  // 14. Health Requests
  try {
    const healthSnap = await clientRef.collection('health_requests').get();
    for (const doc of healthSnap.docs) {
      const row = mapHealthRequestToSupabase(clientId, doc.id, uid, doc.data());
      await insertIgnoreDup('health_requests', row);
    }
  } catch (e: any) { console.warn(`${LOG}   health_requests:`, e.message); }

  // 15. Refund Requests
  try {
    const refundSnap = await clientRef.collection('refund_requests').get();
    for (const doc of refundSnap.docs) {
      const row = mapRefundRequestToSupabase(clientId, doc.id, uid, doc.data());
      await insertIgnoreDup('refund_requests', row);
    }
  } catch (e: any) { console.warn(`${LOG}   refund_requests:`, e.message); }

  // 16. Client Access Credentials
  try {
    const accSnap = await clientRef.collection('Client Acces').get();
    for (const doc of accSnap.docs) {
      const row = mapAccesToSupabase(clientId, doc.id, doc.data());
      row.client_firebase_uid = uid;
      await insertIgnoreDup('client_access_credentials', row);
    }
  } catch (e: any) { console.warn(`${LOG}   access_credentials:`, e.message); }

  // 17. Client Logs
  try {
    const logSnap = await clientRef.collection('Client Logs').get();
    for (const doc of logSnap.docs) {
      const row = mapClientLogToSupabase(clientId, doc.id, doc.data());
      row.client_firebase_uid = uid;
      await insertIgnoreDup('client_logs', row);
    }
  } catch (e: any) { console.warn(`${LOG}   client_logs:`, e.message); }

  // 18. Invoices
  try {
    const invSnap = await clientRef.collection('invoices').get();
    for (const doc of invSnap.docs) {
      const d = doc.data();
      await insertIgnoreDup('invoices', {
        firestore_id: doc.id,
        client_id: clientId,
        client_firebase_uid: uid,
        amount_cents: d.amountCents ?? d.amount_cents ?? d.amount ?? null,
        currency: d.currency || 'ILS',
        description: d.description || null,
        invoice_date: toIso(d.invoiceDate) ?? toIso(d.date) ?? toIso(d.createdAt),
        payment_method: d.paymentMethod || d.method || null,
        payme_transaction_id: d.paymeTransactionId || d.transactionId || null,
        status: d.status || 'paid',
        metadata: d.metadata || {},
        created_at: toIso(d.createdAt) ?? new Date().toISOString()
      });
    }
  } catch (e: any) { console.warn(`${LOG}   invoices:`, e.message); }

  // 19. Saved Tips
  try {
    const tipSnap = await clientRef.collection('Tips').get();
    for (const doc of tipSnap.docs) {
      const row = mapUserSavedTipToSupabase(clientId, doc.id, uid, doc.data());
      await supabase.from('user_saved_tips').upsert(row, { onConflict: 'id' });
    }
  } catch (e: any) { console.warn(`${LOG}   saved_tips:`, e.message); }

  // 20. Settings (preferences, notifications, health_config)
  try {
    const prefSnap = await clientRef.collection('settings').doc('preferences').get();
    if (prefSnap.exists) {
      const row = mapSettingsToSupabase(clientId, prefSnap.data()!);
      await supabase.from('client_settings').upsert(row, { onConflict: 'client_id' });
    }
  } catch (e: any) { console.warn(`${LOG}   settings/preferences:`, e.message); }

  try {
    const notifSettSnap = await clientRef.collection('settings').doc('notifications').get();
    if (notifSettSnap.exists) {
      await supabase.from('notification_settings').upsert({
        client_id: clientId,
        settings: notifSettSnap.data() || {},
        updated_at: new Date().toISOString()
      }, { onConflict: 'client_id' });
    }
  } catch (e: any) { console.warn(`${LOG}   settings/notifications:`, e.message); }

  try {
    const healthSnap = await clientRef.collection('settings').doc('health_config').get();
    if (healthSnap.exists) {
      await supabase.from('health_configs').upsert({
        client_id: clientId,
        config: healthSnap.data() || {},
        updated_at: new Date().toISOString()
      }, { onConflict: 'client_id' });
    }
  } catch (e: any) { console.warn(`${LOG}   settings/health_config:`, e.message); }

  // 21. Subscription Change Quotes
  try {
    const quoteSnap = await clientRef.collection('subscriptionChangeQuotes').get();
    for (const doc of quoteSnap.docs) {
      const d = doc.data();
      await insertIgnoreDup('subscription_change_quotes', {
        firestore_id: doc.id,
        client_id: clientId,
        quote_data: d,
        created_at: toIso(d.createdAt) ?? new Date().toISOString(),
        expires_at: toIso(d.expiresAt)
      });
    }
  } catch (e: any) { console.warn(`${LOG}   sub_change_quotes:`, e.message); }

  // 22. Phones (from client doc field)
  try {
    const phones = fsData['Phone Number'];
    const phoneList: string[] = [];
    if (typeof phones === 'string') phoneList.push(phones);
    else if (Array.isArray(phones)) {
      for (const p of phones) {
        if (typeof p === 'string' && p.trim()) phoneList.push(p.trim());
      }
    }
    for (const ph of [...new Set(phoneList)]) {
      await insertIgnoreDup('client_phones', {
        client_id: clientId,
        phone_e164: ph,
        is_verified: fsData.phoneVerified ?? false,
        source: 'sync'
      });
    }
  } catch (e: any) { console.warn(`${LOG}   phones:`, e.message); }

  // 23. Devices + FCM Tokens (from client doc fields)
  try {
    const devices = fsData.Devices;
    if (Array.isArray(devices)) {
      for (const deviceId of devices) {
        if (typeof deviceId === 'string' && deviceId.trim()) {
          await insertIgnoreDup('client_devices', { client_id: clientId, device_id: deviceId.trim() });
        }
      }
    }
    const tokens = fsData.FCM_Token;
    if (Array.isArray(tokens)) {
      for (const token of tokens) {
        const tokenStr = typeof token === 'string' ? token : token?.token;
        if (tokenStr) {
          await insertIgnoreDup('client_fcm_tokens', {
            client_id: clientId,
            token: tokenStr,
            platform: token?.platform || null,
            device_id: token?.deviceId || null
          });
        }
      }
    }
  } catch (e: any) { console.warn(`${LOG}   devices/fcm:`, e.message); }

  // Dedup all tables for this client
  const duplicatesRemoved = await deduplicateAllTablesForClient(clientId);
  return { duplicatesRemoved };
}

// ─── Main sync entry point ────────────────────────────────────────────────

export async function runFullFirestoreSync(): Promise<SyncReport> {
  const report: SyncReport = {
    totalClients: 0,
    synced: 0,
    errors: 0,
    duplicatesRemoved: 0,
    startedAt: new Date().toISOString(),
    errorDetails: [],
  };

  console.log(`${LOG} Starting full Firestore → Supabase sync...`);

  const db = getFirestore();
  const conseillerMap = await buildConseillerMap();
  console.log(`${LOG} Conseillers map: ${conseillerMap.byName.size} by name, ${conseillerMap.byFirstName.size} by first name`);

  const BATCH = 100;
  let lastDoc: FirebaseFirestore.QueryDocumentSnapshot | null = null;
  let pageNum = 0;

  while (true) {
    let q = db.collection('Clients').orderBy('__name__').limit(BATCH);
    if (lastDoc) q = q.startAfter(lastDoc);

    const snap = await q.get();
    if (snap.empty) break;

    pageNum++;
    console.log(`${LOG} Page ${pageNum}: ${snap.size} clients`);

    for (const doc of snap.docs) {
      report.totalClients++;
      const uid = doc.id;
      try {
        const result = await syncClient(uid, doc.ref, doc.data(), conseillerMap);
        report.synced++;
        report.duplicatesRemoved += result.duplicatesRemoved;
        if (report.synced % 50 === 0) {
          console.log(`${LOG} Progress: ${report.synced}/${report.totalClients} synced`);
        }
      } catch (e: any) {
        report.errors++;
        const msg = `${uid}: ${e.message}`;
        if (report.errorDetails.length < 50) report.errorDetails.push(msg);
        console.error(`${LOG} ERROR ${uid}:`, e.message);
      }
    }

    lastDoc = snap.docs[snap.docs.length - 1]!;
    if (snap.size < BATCH) break;
  }

  report.completedAt = new Date().toISOString();

  console.log(`${LOG} === Sync Complete ===`);
  console.log(`${LOG} Total: ${report.totalClients} | Synced: ${report.synced} | Errors: ${report.errors}`);
  console.log(`${LOG} Duplicates removed: ${report.duplicatesRemoved}`);
  console.log(`${LOG} Duration: ${((new Date(report.completedAt).getTime() - new Date(report.startedAt).getTime()) / 1000).toFixed(0)}s`);

  // Log to Firestore Jobs for catch-up awareness
  try {
    await db.collection('Jobs').doc('dailyFirestoreSync').set({
      lastSuccessAt: new Date(),
      report: { synced: report.synced, errors: report.errors, duplicatesRemoved: report.duplicatesRemoved },
    }, { merge: true });
  } catch { /* best-effort */ }

  return report;
}
