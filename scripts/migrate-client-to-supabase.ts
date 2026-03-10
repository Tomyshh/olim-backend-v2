import 'dotenv/config';
import { initializeFirebase, getFirestore } from '../src/config/firebase.js';
import { createClient } from '@supabase/supabase-js';
import {
  mapClientToSupabase,
  mapSubscriptionToSupabase,
  mapAddressToSupabase,
  mapFamilyMemberToSupabase,
  mapPaymentCredentialToSupabase,
  mapChatConversationToSupabase,
  mapChatMessageToSupabase,
  mapFavoriteRequestToSupabase,
  mapNotificationToSupabase,
  mapAppointmentToSupabase,
  mapAccesToSupabase,
  mapClientLogToSupabase,
  mapUserSavedTipToSupabase,
  mapSettingsToSupabase,
  mapPromotionToSupabase,
  mapPromoRevertToSupabase,
  mapContactMessageToSupabase,
  mapRefundRequestToSupabase,
  mapHealthRequestToSupabase,
  mapSupportTicketToSupabase,
  mapRequestDraftToSupabase,
  mapLegacyRequestToSupabase,
  resolveDocumentTypeId,
  resolveConseillerUuid,
  resolveSupabaseClientId as resolveClientUuidFromFirebaseUid
} from '../src/services/dualWrite.service.js';

/**
 * migrate-client-to-supabase.ts
 *
 * Migrates one or all clients from Firestore to Supabase (data + Supabase Auth).
 * 100% READ-ONLY on Firestore -- never deletes or modifies Firestore data.
 *
 * Usage:
 *   npx tsx scripts/migrate-client-to-supabase.ts --uid <firebase_uid>
 *   npx tsx scripts/migrate-client-to-supabase.ts --all
 *   npx tsx scripts/migrate-client-to-supabase.ts --all --dry-run
 *   npx tsx scripts/migrate-client-to-supabase.ts --all --batch-size 50
 */

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
if (!supabaseUrl || !supabaseKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SECRET_KEY');
  process.exit(1);
}
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { autoRefreshToken: false, persistSession: false }
});

function pickArg(name: string): string {
  const idx = process.argv.findIndex((x) => x === `--${name}`);
  if (idx >= 0) return String(process.argv[idx + 1] || '').trim();
  return '';
}
const hasFlag = (name: string) => process.argv.includes(`--${name}`);

interface MigrationReport {
  total: number;
  success: number;
  skipped: number;
  errors: { uid: string; error: string }[];
  startedAt: string;
  completedAt?: string;
}

const report: MigrationReport = {
  total: 0, success: 0, skipped: 0, errors: [],
  startedAt: new Date().toISOString()
};

function toIso(v: unknown): string | null {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object' && 'toDate' in (v as any)) {
    try { return (v as any).toDate().toISOString(); } catch { return null; }
  }
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return null;
    // DD/MM/YYYY or DD-MM-YYYY or DD.MM.YYYY → ISO
    const dmy = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/);
    if (dmy) {
      const [, dd, mm, yyyy] = dmy;
      return `${yyyy}-${mm!.padStart(2, '0')}-${dd!.padStart(2, '0')}T00:00:00.000Z`;
    }
    return s;
  }
  if (typeof v === 'number') return new Date(v).toISOString();
  return null;
}

function normalizeDocTypeSlug(raw: string): string {
  const s = raw.toLowerCase().trim();
  if (s.includes('teoudat z') || s.includes('teudat z') || s.includes('תעודת זהות') || s === 'tz') return 'teudat_zehut';
  if (s.includes('teoudat ol')) return 'teudat_ole';
  if (s.includes('passeport') && (s.includes('etranger') || s.includes('franc'))) return 'passeport_etranger';
  if (s.includes('passeport') || s === 'passport') return 'passeport';
  if (s.includes('permis de conduire') || s === 'driving license') return 'permis_conduire';
  if (s.includes('carte de cr') || s.includes('credit card')) return 'carte_credit';
  if (s.includes("carte d'identit") || s.includes('carte d\'identit')) return 'carte_identite';
  if (s.includes('carte grise') || s.includes('vehicle registration')) return 'carte_grise';
  if (s.includes('koupat') || s.includes('health fund')) return 'carte_koupat_holim';
  if (s.includes('contrat de location') || s.includes('rental contract')) return 'contrat_location';
  if (s.includes('compteur') && s.includes('eau') || s.includes('water meter')) return 'compteur_eau';
  if (s.includes('compteur') && s.includes('gaz')) return 'compteur_gaz';
  if (s.includes('compteur') && (s.includes('lectricit') || s.includes('lectr')) || s.includes('electricity meter')) return 'compteur_electricite';
  if (s.includes('arnona')) return 'facture_arnona';
  if (s.includes("facture d'eau") || s.includes('facture deau')) return 'facture_eau';
  if (s.includes('facture de gaz')) return 'facture_gaz';
  if (s.includes("facture d'") && s.includes('lectricit') || s.includes('electricity bill')) return 'facture_electricite';
  if (s.includes('facture') && s.includes('phone')) return 'facture_telephone';
  if (s.includes('fiche de paie') || s.includes('bulletin') && s.includes('salaire')) return 'fiche_paie';
  if (s.includes('relev') && (s.includes('bancaire') || s.includes('compte'))) return 'releve_bancaire';
  if (s === 'rib') return 'rib';
  if (s.includes('sefah')) return 'sefah';
  if (s.includes('acte de naissance')) return 'acte_naissance';
  if (s.includes('assurance auto')) return 'assurance_auto';
  if (s.includes('assurance habitation') || s.includes('home insurance')) return 'assurance_habitation';
  if (s.includes('attestation') && s.includes('travail')) return 'attestation_travail';
  if (s.includes('ordonnance')) return 'ordonnance';
  if (s.includes("photos d'identit") || s.includes('photos d\'identit')) return 'photos_identite';
  if (s.includes('justificatif') && s.includes('revenus')) return 'justificatif_revenus';
  if (s.includes('dipl')) return 'diplome';
  if (s.includes('document m') && s.includes('dic') || s.includes('rapport') && s.includes('dic')) return 'document_medical';
  if (s.includes('profile_photo') || s === 'profile photo') return 'profile_photo';
  if (s.includes('request_attachment')) return 'request_attachment';
  return 'autre';
}

async function ensureAuthUser(email: string, firebaseUid: string): Promise<string | null> {
  if (!email || !email.includes('@')) return null;
  const normalizedEmail = email.trim().toLowerCase();

  try {
    const { data: createData, error: createError } = await supabase.auth.admin.createUser({
      email: normalizedEmail,
      password: crypto.randomUUID() + crypto.randomUUID(),
      email_confirm: true,
      user_metadata: { firebase_uid: firebaseUid, migrated_from: 'firebase', migrated_at: new Date().toISOString() }
    });
    if (!createError && createData.user) return createData.user.id;

    if (createError?.message?.includes('already') || createError?.message?.includes('exists')) {
      const { data: listData } = await supabase.auth.admin.listUsers({ page: 1, perPage: 50 });
      const found = listData?.users?.find(u => u.email?.toLowerCase() === normalizedEmail);
      if (found) return found.id;
    }
    console.warn(`  [auth] Could not create user for ${normalizedEmail}:`, createError?.message);
    return null;
  } catch (e) {
    console.warn(`  [auth] Exception for ${normalizedEmail}:`, e);
    return null;
  }
}

async function upsertRow(table: string, data: Record<string, any>, onConflict: string): Promise<string | null> {
  for (const k of Object.keys(data)) {
    if (data[k] === undefined) delete data[k];
  }
  const { data: result, error } = await supabase
    .from(table)
    .upsert(data, { onConflict })
    .select('id')
    .maybeSingle();

  if (error) {
    console.error(`  [${table}] upsert error:`, error.message);
    return null;
  }
  return result?.id ?? null;
}

async function insertRow(table: string, data: Record<string, any>): Promise<string | null> {
  for (const k of Object.keys(data)) {
    if (data[k] === undefined) delete data[k];
  }
  const { data: result, error } = await supabase
    .from(table)
    .insert(data)
    .select('id')
    .maybeSingle();

  if (error) {
    if (error.message?.includes('duplicate') || error.message?.includes('unique')) {
      return null;
    }
    console.error(`  [${table}] insert error:`, error.message);
    return null;
  }
  return result?.id ?? null;
}

async function migrateClient(uid: string, dryRun: boolean): Promise<boolean> {
  const db = getFirestore();
  const clientRef = db.collection('Clients').doc(uid);
  const clientSnap = await clientRef.get();

  if (!clientSnap.exists) {
    console.log(`  SKIP: Clients/${uid} does not exist`);
    report.skipped++;
    return true;
  }

  const fsData = clientSnap.data()!;
  const email = (fsData.Email || fsData.email || '') as string;

  if (dryRun) {
    console.log(`  [DRY-RUN] Would migrate: ${uid} (${email})`);
    return true;
  }

  // 1. Supabase Auth
  let authUserId: string | null = null;
  if (email) {
    authUserId = await ensureAuthUser(email, uid);
    if (authUserId) console.log(`  Auth user: ${authUserId}`);
  }

  // 2. clients table
  const clientRow = mapClientToSupabase(uid, fsData);
  if (authUserId) clientRow.auth_user_id = authUserId;
  const clientId = await upsertRow('clients', clientRow, 'firebase_uid');
  if (!clientId) {
    console.error(`  FAIL: Could not upsert client ${uid}`);
    return false;
  }
  console.log(`  Client inserted: ${clientId}`);

  // 3. subscription/current
  try {
    const subSnap = await clientRef.collection('subscription').doc('current').get();
    if (subSnap.exists) {
      const subRow = await mapSubscriptionToSupabase(clientId, subSnap.data()!);
      await upsertRow('subscriptions', subRow, 'client_id');
      console.log(`  Subscription migrated`);
    }
  } catch (e) { console.warn(`  subscription error:`, e); }

  // 4. Addresses
  try {
    const addrSnap = await clientRef.collection('Addresses').get();
    for (const doc of addrSnap.docs) {
      const row = mapAddressToSupabase(clientId, doc.id, doc.data());
      await insertRow('client_addresses', row);
    }
    if (addrSnap.size > 0) console.log(`  Addresses: ${addrSnap.size}`);
  } catch (e) { console.warn(`  addresses error:`, e); }

  // 5. Family Members
  try {
    const famSnap = await clientRef.collection('Family Members').get();
    for (const doc of famSnap.docs) {
      const row = await mapFamilyMemberToSupabase(clientId, doc.id, doc.data());
      await insertRow('family_members', row);
    }
    if (famSnap.size > 0) console.log(`  Family Members: ${famSnap.size}`);
  } catch (e) { console.warn(`  family members error:`, e); }

  // 6. Payment credentials
  try {
    const paySnap = await clientRef.collection('Payment credentials').get();
    for (const doc of paySnap.docs) {
      const row = mapPaymentCredentialToSupabase(clientId, doc.id, doc.data());
      await insertRow('payment_credentials', row);
    }
    if (paySnap.size > 0) console.log(`  Payment credentials: ${paySnap.size}`);
  } catch (e) { console.warn(`  payment credentials error:`, e); }

  // 7. Client Documents
  try {
    const docSnap = await clientRef.collection('Client Documents').get();
    for (const doc of docSnap.docs) {
      const d = doc.data();
      const rawDocType = d['Document Type'] || d.documentType || 'unknown';
      const docTypeSlug = normalizeDocTypeSlug(rawDocType);
      const documentTypeId = await resolveDocumentTypeId(docTypeSlug);

      const docId = await insertRow('client_documents', {
        client_id: clientId,
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
            await insertRow('client_document_files', {
              client_document_id: docId,
              url
            });
          }
        }
      }
    }
    if (docSnap.size > 0) console.log(`  Documents: ${docSnap.size}`);
  } catch (e) { console.warn(`  documents error:`, e); }

  // 8. Devices (from client doc field)
  try {
    const devices = fsData.Devices;
    if (Array.isArray(devices)) {
      for (const deviceId of devices) {
        if (typeof deviceId === 'string' && deviceId.trim()) {
          await insertRow('client_devices', {
            client_id: clientId,
            device_id: deviceId.trim()
          });
        }
      }
    }
  } catch (e) { console.warn(`  devices error:`, e); }

  // 9. FCM Tokens (from client doc field)
  try {
    const tokens = fsData.FCM_Token;
    if (Array.isArray(tokens)) {
      for (const token of tokens) {
        const tokenStr = typeof token === 'string' ? token : (token?.token || null);
        if (tokenStr) {
          await insertRow('client_fcm_tokens', {
            client_id: clientId,
            token: tokenStr,
            platform: token?.platform || null,
            device_id: token?.deviceId || null
          });
        }
      }
    }
  } catch (e) { console.warn(`  fcm tokens error:`, e); }

  // 10. Phone Numbers (from client doc field)
  try {
    const phones = fsData['Phone Number'];
    const phoneList: string[] = [];
    if (typeof phones === 'string') phoneList.push(phones);
    else if (Array.isArray(phones)) {
      for (const p of phones) {
        if (typeof p === 'string' && p.trim()) phoneList.push(p.trim());
      }
    }
    for (const phone of [...new Set(phoneList)]) {
      await insertRow('client_phones', {
        client_id: clientId,
        phone_e164: phone,
        is_verified: fsData.phoneVerified ?? false,
        verified_at: toIso(fsData.phoneVerifiedAt),
        source: 'migration'
      });
    }
  } catch (e) { console.warn(`  phones error:`, e); }

  // 11. Favorite Requests
  try {
    const favSnap = await clientRef.collection('favoriteRequests').get();
    for (const doc of favSnap.docs) {
      const row = mapFavoriteRequestToSupabase(clientId, doc.id, doc.data());
      await upsertRow('favorite_requests', row, 'firestore_id');
    }
    if (favSnap.size > 0) console.log(`  Favorites: ${favSnap.size}`);
  } catch (e) { console.warn(`  favorites error:`, e); }

  // 12. Conversations + Messages
  try {
    const convoSnap = await clientRef.collection('Conversations').get();
    for (const convoDoc of convoSnap.docs) {
      const convoRow = mapChatConversationToSupabase(clientId, convoDoc.id, convoDoc.data());
      const convoId = await upsertRow('chat_conversations', convoRow, 'firestore_id');
      if (convoId) {
        const msgSnap = await convoDoc.ref.collection('Messages').get();
        for (const msgDoc of msgSnap.docs) {
          const msgRow = mapChatMessageToSupabase(convoId, msgDoc.id, msgDoc.data());
          await insertRow('chat_messages', msgRow);
        }
      }
    }
    if (convoSnap.size > 0) console.log(`  Conversations: ${convoSnap.size}`);
  } catch (e) { console.warn(`  conversations error:`, e); }

  // 13. Notifications
  try {
    const notifSnap = await clientRef.collection('notifications').get();
    for (const doc of notifSnap.docs) {
      const row = mapNotificationToSupabase(clientId, doc.id, doc.data());
      await insertRow('notifications', row);
    }
    if (notifSnap.size > 0) console.log(`  Notifications: ${notifSnap.size}`);
  } catch (e) { console.warn(`  notifications error:`, e); }

  // 14. Appointments
  try {
    const apptSnap = await clientRef.collection('appointments').get();
    for (const doc of apptSnap.docs) {
      const row = mapAppointmentToSupabase(clientId, doc.id, doc.data());
      await insertRow('appointments', row);
    }
    if (apptSnap.size > 0) console.log(`  Appointments: ${apptSnap.size}`);
  } catch (e) { console.warn(`  appointments error:`, e); }

  // 15. Request Drafts
  try {
    const draftSnap = await clientRef.collection('RequestDrafts').get();
    for (const doc of draftSnap.docs) {
      const d = doc.data();
      await insertRow('request_drafts', {
        firestore_id: doc.id,
        client_id: clientId,
        draft_type: d.type || 'manual_conversational',
        title: d.title || null,
        category: d.category || null,
        subcategory: d.subcategory || null,
        progress: d.progress ?? 0,
        current_step: d.current_step || null,
        snapshot_json: d.snapshot_json || {},
        uploaded_urls: d.uploaded_urls || [],
        client_temp_id: d.client_temp_id || null,
        expires_at: toIso(d.expires_at),
        created_at: toIso(d.created_at),
        updated_at: toIso(d.updated_at) ?? new Date().toISOString()
      });
    }
    if (draftSnap.size > 0) console.log(`  Drafts: ${draftSnap.size}`);
  } catch (e) { console.warn(`  drafts error:`, e); }

  // 16. Support Tickets
  try {
    const ticketSnap = await clientRef.collection('support_tickets').get();
    for (const doc of ticketSnap.docs) {
      const d = doc.data();
      await insertRow('support_tickets', {
        firestore_id: doc.id,
        client_id: clientId,
        client_firebase_uid: uid,
        subject: d.subject || '',
        description: d.description || null,
        priority: d.priority || 'normal',
        status: d.status || 'open',
        created_at: toIso(d.createdAt),
        updated_at: toIso(d.updatedAt) ?? new Date().toISOString()
      });
    }
    if (ticketSnap.size > 0) console.log(`  Support tickets: ${ticketSnap.size}`);
  } catch (e) { console.warn(`  support tickets error:`, e); }

  // 17. Health Requests
  try {
    const healthSnap = await clientRef.collection('health_requests').get();
    for (const doc of healthSnap.docs) {
      const d = doc.data();
      await insertRow('health_requests', {
        firestore_id: doc.id,
        client_id: clientId,
        client_firebase_uid: uid,
        request_type: d.type || 'general',
        description: d.description || '',
        data: d.data || {},
        status: d.status || 'pending',
        created_at: toIso(d.createdAt)
      });
    }
    if (healthSnap.size > 0) console.log(`  Health requests: ${healthSnap.size}`);
  } catch (e) { console.warn(`  health requests error:`, e); }

  // 18. Refund Requests
  try {
    const refundSnap = await clientRef.collection('refund_requests').get();
    for (const doc of refundSnap.docs) {
      const d = doc.data();
      await insertRow('refund_requests', {
        firestore_id: doc.id,
        client_id: clientId,
        client_firebase_uid: uid,
        amount_cents: d.amountCents || d.amount_cents || null,
        reason: d.reason || null,
        status: d.status || 'pending',
        created_at: toIso(d.createdAt)
      });
    }
    if (refundSnap.size > 0) console.log(`  Refund requests: ${refundSnap.size}`);
  } catch (e) { console.warn(`  refund requests error:`, e); }

  // 19. Client Access Credentials (Client Acces)
  try {
    const accSnap = await clientRef.collection('Client Acces').get();
    for (const doc of accSnap.docs) {
      const row = mapAccesToSupabase(clientId, doc.id, doc.data());
      row.client_firebase_uid = uid;
      await insertRow('client_access_credentials', row);
    }
    if (accSnap.size > 0) console.log(`  Access credentials: ${accSnap.size}`);
  } catch (e) { console.warn(`  access credentials error:`, e); }

  // 20. Client Logs
  try {
    const logSnap = await clientRef.collection('Client Logs').get();
    for (const doc of logSnap.docs) {
      const row = mapClientLogToSupabase(clientId, doc.id, doc.data());
      row.client_firebase_uid = uid;
      await insertRow('client_logs', row);
    }
    if (logSnap.size > 0) console.log(`  Client logs: ${logSnap.size}`);
  } catch (e) { console.warn(`  client logs error:`, e); }

  // 21. Invoices
  try {
    const invSnap = await clientRef.collection('invoices').get();
    for (const doc of invSnap.docs) {
      const d = doc.data();
      await insertRow('invoices', {
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
    if (invSnap.size > 0) console.log(`  Invoices: ${invSnap.size}`);
  } catch (e) { console.warn(`  invoices error:`, e); }

  // 22. Saved Tips (Clients/{uid}/Tips)
  try {
    const tipSnap = await clientRef.collection('Tips').get();
    for (const doc of tipSnap.docs) {
      const row = mapUserSavedTipToSupabase(clientId, doc.id, uid, doc.data());
      await supabase.from('user_saved_tips').upsert(row, { onConflict: 'id' });
    }
    if (tipSnap.size > 0) console.log(`  Saved tips: ${tipSnap.size}`);
  } catch (e) { console.warn(`  saved tips error:`, e); }

  // 23. Settings (preferences, notifications, health_config)
  try {
    const prefSnap = await clientRef.collection('settings').doc('preferences').get();
    if (prefSnap.exists) {
      const row = mapSettingsToSupabase(clientId, prefSnap.data()!);
      await supabase.from('client_settings').upsert(row, { onConflict: 'client_id' });
      console.log(`  Settings: preferences`);
    }
  } catch (e) { console.warn(`  settings/preferences error:`, e); }

  try {
    const notifSnap = await clientRef.collection('settings').doc('notifications').get();
    if (notifSnap.exists) {
      await supabase.from('notification_settings').upsert({
        client_id: clientId,
        settings: notifSnap.data() || {},
        updated_at: new Date().toISOString()
      }, { onConflict: 'client_id' });
      console.log(`  Settings: notifications`);
    }
  } catch (e) { console.warn(`  settings/notifications error:`, e); }

  try {
    const healthSnap = await clientRef.collection('settings').doc('health_config').get();
    if (healthSnap.exists) {
      await supabase.from('health_configs').upsert({
        client_id: clientId,
        config: healthSnap.data() || {},
        updated_at: new Date().toISOString()
      }, { onConflict: 'client_id' });
      console.log(`  Settings: health_config`);
    }
  } catch (e) { console.warn(`  settings/health_config error:`, e); }

  // 24. Subscription Change Quotes
  try {
    const quoteSnap = await clientRef.collection('subscriptionChangeQuotes').get();
    for (const doc of quoteSnap.docs) {
      const d = doc.data();
      await insertRow('subscription_change_quotes', {
        firestore_id: doc.id,
        client_id: clientId,
        quote_data: d,
        created_at: toIso(d.createdAt) ?? new Date().toISOString(),
        expires_at: toIso(d.expiresAt)
      });
    }
    if (quoteSnap.size > 0) console.log(`  Sub change quotes: ${quoteSnap.size}`);
  } catch (e) { console.warn(`  subscription change quotes error:`, e); }

  // 25. Docs/Personnels (personal documents)
  try {
    const docsSnap = await clientRef.collection('Docs').doc('Personnels').get();
    if (docsSnap.exists) {
      const d = docsSnap.data()!;
      for (const [key, value] of Object.entries(d)) {
        if (!value) continue;
        const docSlug = normalizeDocTypeSlug(key);
        const docTypeId = await resolveDocumentTypeId(docSlug);
        await insertRow('client_documents', {
          client_id: clientId,
          document_type: key,
          document_type_id: docTypeId,
          for_who: 'personal',
          file_url: typeof value === 'string' ? value : (value as any)?.url || null,
          metadata: typeof value === 'object' ? value as any : { value },
          created_at: new Date().toISOString()
        });
      }
      console.log(`  Docs/Personnels: ${Object.keys(d).length} fields`);
    }
  } catch (e) { console.warn(`  Docs/Personnels error:`, e); }

  // 26. Legacy Requests (Clients/{uid}/Requests)
  try {
    const reqSnap = await clientRef.collection('Requests').get();
    for (const doc of reqSnap.docs) {
      const row = mapLegacyRequestToSupabase(uid, doc.id, doc.data());
      row.client_id = clientId;
      await supabase.from('requests').upsert(row, { onConflict: 'unique_id' });
    }
    if (reqSnap.size > 0) console.log(`  Legacy requests: ${reqSnap.size}`);
  } catch (e) { console.warn(`  legacy requests error:`, e); }

  return true;
}

// ═══════════════════════════════════════════════════════════════════════════
// Root collection migrations (Firestore → Supabase)
// ═══════════════════════════════════════════════════════════════════════════

async function migrateRootCollections(db: FirebaseFirestore.Firestore, dryRun: boolean): Promise<void> {
  console.log('\n========== ROOT COLLECTIONS ==========\n');

  // Conseillers2
  try {
    const snap = await db.collection('Conseillers2').get();
    if (dryRun) { console.log(`  [DRY-RUN] Conseillers2: ${snap.size}`); }
    else {
      let count = 0;
      for (const doc of snap.docs) {
        const d = doc.data();
        const { error } = await supabase.from('conseillers').upsert({
          firestore_id: doc.id,
          name: d.name || d.Name || doc.id,
          email: d.email || d.Email || null,
          is_admin: d.isAdmin ?? false,
          is_super_admin: d.superAdmin ?? d.isSuperAdmin ?? false,
          is_present: d.isPresent ?? false,
          manage_elite: d.manageElite ?? d.manage_elite ?? false,
          languages: d.languages ?? d.Languages ?? {},
          now_request: d.now_request || null,
          metadata: { raw: d },
          created_at: toIso(d.createdAt) ?? new Date().toISOString(),
          updated_at: new Date().toISOString()
        }, { onConflict: 'firestore_id' });
        if (!error) count++;
      }
      console.log(`  Conseillers2: ${count}/${snap.size}`);
    }
  } catch (e) { console.warn('  Conseillers2 error:', e); }

  // Promotions
  try {
    const snap = await db.collection('Promotions').get();
    if (dryRun) { console.log(`  [DRY-RUN] Promotions: ${snap.size}`); }
    else {
      let count = 0;
      for (const doc of snap.docs) {
        const row = mapPromotionToSupabase(doc.id, doc.data());
        if (!row.created_at) row.created_at = new Date().toISOString();
        const { error } = await supabase.from('promotions').upsert(row, { onConflict: 'firestore_id' });
        if (!error) count++;
        else console.warn(`    promo ${doc.id}:`, error.message);
      }
      console.log(`  Promotions: ${count}/${snap.size}`);
    }
  } catch (e) { console.warn('  Promotions error:', e); }

  // PromoReverts
  try {
    const snap = await db.collection('PromoReverts').get();
    if (dryRun) { console.log(`  [DRY-RUN] PromoReverts: ${snap.size}`); }
    else {
      let count = 0;
      for (const doc of snap.docs) {
        const row = mapPromoRevertToSupabase(doc.id, doc.data());
        const { error } = await supabase.from('promo_reverts').upsert(row, { onConflict: 'id' });
        if (!error) count++;
        else if (!error?.message?.includes('duplicate')) console.warn('  promo_reverts:', error?.message);
      }
      console.log(`  PromoReverts: ${count}/${snap.size}`);
    }
  } catch (e) { console.warn('  PromoReverts error:', e); }

  // ContactMessages
  try {
    const snap = await db.collection('ContactMessages').get();
    if (dryRun) { console.log(`  [DRY-RUN] ContactMessages: ${snap.size}`); }
    else {
      let count = 0;
      for (const doc of snap.docs) {
        const row = mapContactMessageToSupabase(doc.id, doc.data());
        const { error } = await supabase.from('contact_messages').insert(row);
        if (!error) count++;
        else if (!error?.message?.includes('duplicate')) count++;
      }
      console.log(`  ContactMessages: ${count}/${snap.size}`);
    }
  } catch (e) { console.warn('  ContactMessages error:', e); }

  // ChatCC + messages
  try {
    const snap = await db.collection('ChatCC').get();
    console.log(`  ChatCC: scanning ${snap.size} chats...`);
    if (dryRun) { console.log(`  [DRY-RUN] ChatCC: ${snap.size}`); }
    else {
      let chatCount = 0, msgCount = 0;
      for (const doc of snap.docs) {
        const d = doc.data();
        const ccClientId = d.clientId || d.client_id || d.uid || '';
        const ccCounselorId = d.counselorId || d.counselor_id || '';
        const [ccClientUuid, ccCounselorUuid] = await Promise.all([
          ccClientId ? resolveClientUuidFromFirebaseUid(ccClientId) : null,
          ccCounselorId ? resolveConseillerUuid(ccCounselorId) : null,
        ]);
        const { data: chatRow, error } = await supabase.from('chatcc').upsert({
          firestore_id: doc.id,
          client_id: ccClientId,
          client_uuid: ccClientUuid,
          counselor_id: ccCounselorId,
          counselor_uuid: ccCounselorUuid,
          counselor_name: d.counselorName || d.counselor_name || null,
          request_id: d.requestId || null,
          is_done: d.isDone ?? d.is_done ?? false,
          is_done_by: d.isDoneBy || null,
          last_message: d.lastMessage || d.last_message || null,
          last_timestamp: toIso(d.lastTimestamp) ?? toIso(d.last_timestamp),
          welcome_shown_to_client: d.welcomeShownToClient ?? false,
          welcome_shown_at: toIso(d.welcomeShownAt),
          unread_for_client: d.unreadForClient ?? d.unread_for_client ?? 0,
          unread_for_counselor: d.unreadForCounselor ?? d.unread_for_counselor ?? 0,
          is_favorite: d.isFavorite ?? false,
          closed_chat_date: toIso(d.closedChatDate),
          satisfaction_score: d.satisfaction_score ?? d.satisfactionScore ?? null,
          chat_rating: d.chat_rating ?? d.chatRating ?? null,
          chat_rating_date: toIso(d.chat_rating_date) ?? toIso(d.chatRatingDate),
          chat_rating_skipped: d.chat_rating_skipped ?? d.chatRatingSkipped ?? null,
          chat_rating_tags: d.chat_rating_tags ?? d.chatRatingTags ?? [],
          evaluation_date: toIso(d.evaluation_date) ?? toIso(d.evaluationDate),
          evaluation_feedback: d.evaluation_feedback ?? d.evaluationFeedback ?? null,
          evaluation_strengths: d.evaluation_strengths ?? d.evaluationStrengths ?? null,
          evaluation_improvements: d.evaluation_improvements ?? d.evaluationImprovements ?? null,
          evaluation_note: d.evaluation_note ?? d.evaluationNote ?? null,
          metadata: {},
          created_at: toIso(d.createdAt) ?? new Date().toISOString()
        }, { onConflict: 'firestore_id' }).select('id').maybeSingle();

        if (!error && chatRow?.id) {
          chatCount++;
          const msgSnap = await doc.ref.collection('messages').get();
          for (const msgDoc of msgSnap.docs) {
            const m = msgDoc.data();
            const msgClientId = m.clientId || m.client_id || null;
            const msgClientUuid = msgClientId ? await resolveClientUuidFromFirebaseUid(msgClientId) : null;
            const { error: msgErr } = await supabase.from('chatcc_messages').insert({
              firestore_id: msgDoc.id,
              chatcc_id: chatRow.id,
              client_id: msgClientId,
              client_uuid: msgClientUuid,
              request_id: m.requestId || m.request_id || null,
              sender_id: m.senderId || m.sender_id || '',
              sender_name: m.senderName || m.sender_name || null,
              content: m.content || null,
              type: m.type || 'text',
              file_url: m.fileUrl || m.file_url || null,
              is_uploading: m.isUploading ?? false,
              read_by: m.readBy || m.read_by || [],
              created_at: toIso(m.timestamp) ?? toIso(m.createdAt) ?? new Date().toISOString()
            });
            if (!msgErr) msgCount++;
          }
        }
      }
      console.log(`  ChatCC: ${chatCount}/${snap.size} chats, ${msgCount} messages`);
    }
  } catch (e) { console.warn('  ChatCC error:', e); }

  // Tips (root collection)
  try {
    const snap = await db.collection('Tips').get();
    if (dryRun) { console.log(`  [DRY-RUN] Tips: ${snap.size}`); }
    else {
      let count = 0;
      for (const doc of snap.docs) {
        const d = doc.data();
        const { error } = await supabase.from('tips').upsert({
          firestore_id: doc.id,
          metadata: d,
          created_at: toIso(d.createdAt) ?? new Date().toISOString(),
          updated_at: new Date().toISOString()
        }, { onConflict: 'firestore_id' });
        if (!error) count++;
      }
      console.log(`  Tips: ${count}/${snap.size}`);
    }
  } catch (e) { console.warn('  Tips error:', e); }

  // FAQs
  try {
    const snap = await db.collection('FAQs').get();
    if (dryRun) { console.log(`  [DRY-RUN] FAQs: ${snap.size}`); }
    else {
      let count = 0;
      for (const doc of snap.docs) {
        const d = doc.data();
        const { error } = await supabase.from('faqs').insert({
          firestore_id: doc.id,
          question: d.question || d.Question || '',
          answer: d.answer || d.Answer || '',
          category: d.category || null,
          display_order: d.order ?? d.display_order ?? 0,
          is_active: d.isActive ?? true,
          metadata: {},
          created_at: toIso(d.createdAt) ?? new Date().toISOString()
        });
        if (!error) count++;
      }
      console.log(`  FAQs: ${count}/${snap.size}`);
    }
  } catch (e) { console.warn('  FAQs error:', e); }

  // SupportContacts
  try {
    const snap = await db.collection('SupportContacts').get();
    if (dryRun) { console.log(`  [DRY-RUN] SupportContacts: ${snap.size}`); }
    else {
      let count = 0;
      for (const doc of snap.docs) {
        const d = doc.data();
        const { error } = await supabase.from('support_contacts').insert({
          firestore_id: doc.id,
          name: d.name || d.Name || '',
          role: d.role || d.Role || null,
          email: d.email || d.Email || null,
          phone: d.phone || d.Phone || null,
          whatsapp: d.whatsapp || d.Whatsapp || null,
          is_active: d.isActive ?? true,
          display_order: d.order ?? d.display_order ?? 0,
          metadata: {},
          created_at: toIso(d.createdAt) ?? new Date().toISOString()
        });
        if (!error) count++;
      }
      console.log(`  SupportContacts: ${count}/${snap.size}`);
    }
  } catch (e) { console.warn('  SupportContacts error:', e); }

  // News
  try {
    const snap = await db.collection('News').get();
    if (dryRun) { console.log(`  [DRY-RUN] News: ${snap.size}`); }
    else {
      let count = 0;
      for (const doc of snap.docs) {
        const d = doc.data();
        const { error } = await supabase.from('news').upsert({
          firestore_id: doc.id,
          title: d.title || d.Title || null,
          content: d.content || d.Content || d.body || null,
          category: d.category || null,
          is_breaking: d.isBreaking ?? d.is_breaking ?? false,
          is_active: d.isActive ?? true,
          display_order: d.order ?? 0,
          metadata: {},
          created_at: toIso(d.createdAt) ?? toIso(d.date) ?? new Date().toISOString(),
          updated_at: new Date().toISOString()
        }, { onConflict: 'firestore_id' });
        if (!error) count++;
      }
      console.log(`  News: ${count}/${snap.size}`);
    }
  } catch (e) { console.warn('  News error:', e); }

  // AvailableSlots
  try {
    const snap = await db.collection('AvailableSlots').get();
    if (dryRun) { console.log(`  [DRY-RUN] AvailableSlots: ${snap.size}`); }
    else {
      let count = 0;
      for (const doc of snap.docs) {
        const d = doc.data();
        const { error } = await supabase.from('available_slots').upsert({
          firestore_id: doc.id,
          slot_date: d.date || null,
          slot_time: d.time || null,
          is_available: d.available ?? d.isAvailable ?? true,
          metadata: d.metadata || {},
          created_at: toIso(d.createdAt) ?? new Date().toISOString()
        }, { onConflict: 'firestore_id' });
        if (!error) count++;
      }
      console.log(`  AvailableSlots: ${count}/${snap.size}`);
    }
  } catch (e) { console.warn('  AvailableSlots error:', e); }

  // iCinema
  try {
    const snap = await db.collection('iCinema').get();
    if (dryRun) { console.log(`  [DRY-RUN] iCinema: ${snap.size}`); }
    else {
      let movieCount = 0, seanceCount = 0;
      for (const doc of snap.docs) {
        const d = doc.data();
        const { data: movieRow, error } = await supabase.from('icinema_movies').upsert({
          firestore_id: doc.id,
          title: d.title || d.Title || null,
          language: d.language || null,
          age_rating: d.ageRating || d.age_rating || null,
          duration: d.duration || null,
          genre: d.genre || null,
          image_large: d.imageLarge || d.image_large || null,
          image_long: d.imageLong || d.image_long || null,
          director: d.director || null,
          metadata: {},
          created_at: toIso(d.createdAt) ?? new Date().toISOString(),
          updated_at: new Date().toISOString()
        }, { onConflict: 'firestore_id' }).select('id').maybeSingle();

        if (!error && movieRow?.id) {
          movieCount++;
          try {
            const seanceSnap = await doc.ref.collection('Seances').get();
            for (const sDoc of seanceSnap.docs) {
              const s = sDoc.data();
              const { error: sErr } = await supabase.from('icinema_seances').insert({
                firestore_id: sDoc.id,
                movie_id: movieRow.id,
                showtime: toIso(s.showtime) ?? toIso(s.date),
                hall: s.hall || s.Hall || null,
                metadata: {},
                created_at: toIso(s.createdAt) ?? new Date().toISOString()
              });
              if (!sErr) seanceCount++;
            }
          } catch { /* no seances subcollection */ }
        }
      }
      console.log(`  iCinema: ${movieCount}/${snap.size} movies, ${seanceCount} seances`);
    }
  } catch (e) { console.warn('  iCinema error:', e); }

  // AdminAuditLogs
  try {
    const snap = await db.collection('AdminAuditLogs').get();
    if (dryRun) { console.log(`  [DRY-RUN] AdminAuditLogs: ${snap.size}`); }
    else {
      let count = 0;
      for (const doc of snap.docs) {
        const d = doc.data();
        const { error } = await supabase.from('admin_audit_logs').insert({
          action: d.action || 'unknown',
          caller_firebase_uid: d.callerUid || d.caller_firebase_uid || null,
          client_firebase_uid: d.clientUid || d.client_firebase_uid || null,
          ip: null,
          user_agent: null,
          payload: d.payload ?? d,
          created_at: toIso(d.createdAt) ?? new Date().toISOString()
        });
        if (!error) count++;
      }
      console.log(`  AdminAuditLogs: ${count}/${snap.size}`);
    }
  } catch (e) { console.warn('  AdminAuditLogs error:', e); }

  // SystemAlerts
  try {
    const snap = await db.collection('SystemAlerts').get();
    if (dryRun) { console.log(`  [DRY-RUN] SystemAlerts: ${snap.size}`); }
    else {
      let count = 0;
      for (const doc of snap.docs) {
        const d = doc.data();
        const { error } = await supabase.from('system_alerts').insert({
          firestore_id: doc.id,
          alert_type: d.type || d.alert_type || 'info',
          title: d.title || null,
          message: d.message || null,
          severity: d.severity || 'info',
          is_active: d.isActive ?? d.is_active ?? true,
          metadata: {},
          created_at: toIso(d.createdAt) ?? new Date().toISOString(),
          resolved_at: toIso(d.resolvedAt)
        });
        if (!error) count++;
      }
      console.log(`  SystemAlerts: ${count}/${snap.size}`);
    }
  } catch (e) { console.warn('  SystemAlerts error:', e); }

  // SupportTickets (root-level admin copies)
  try {
    const snap = await db.collection('SupportTickets').get();
    if (dryRun) { console.log(`  [DRY-RUN] SupportTickets (root): ${snap.size}`); }
    else {
      let count = 0;
      for (const doc of snap.docs) {
        const d = doc.data();
        const { error } = await supabase.from('support_tickets').insert({
          firestore_id: `root_${doc.id}`,
          client_firebase_uid: d.uid || null,
          subject: d.subject || '',
          description: d.description || null,
          priority: d.priority || 'normal',
          status: d.status || 'open',
          metadata: { source: 'root_collection' },
          created_at: toIso(d.createdAt) ?? new Date().toISOString()
        });
        if (!error) count++;
      }
      console.log(`  SupportTickets (root): ${count}/${snap.size}`);
    }
  } catch (e) { console.warn('  SupportTickets (root) error:', e); }

  // HealthRequests (root-level admin copies)
  try {
    const snap = await db.collection('HealthRequests').get();
    if (dryRun) { console.log(`  [DRY-RUN] HealthRequests (root): ${snap.size}`); }
    else {
      let count = 0;
      for (const doc of snap.docs) {
        const d = doc.data();
        const { error } = await supabase.from('health_requests').insert({
          firestore_id: `root_${doc.id}`,
          client_firebase_uid: d.uid || null,
          request_type: d.type || 'general',
          description: d.description || '',
          data: d.data || {},
          status: d.status || 'pending',
          metadata: { source: 'root_collection' },
          created_at: toIso(d.createdAt) ?? new Date().toISOString()
        });
        if (!error) count++;
      }
      console.log(`  HealthRequests (root): ${count}/${snap.size}`);
    }
  } catch (e) { console.warn('  HealthRequests (root) error:', e); }

  // Announcements
  try {
    const snap = await db.collection('Announcements').get();
    if (dryRun) { console.log(`  [DRY-RUN] Announcements: ${snap.size}`); }
    else {
      let count = 0;
      for (const doc of snap.docs) {
        const d = doc.data();
        const { error } = await supabase.from('announcements').insert({
          firestore_id: doc.id,
          title: d.title || d.Title || '',
          content: d.content || d.Content || d.body || '',
          is_active: d.isActive ?? true,
          metadata: {},
          created_at: toIso(d.createdAt) ?? new Date().toISOString()
        });
        if (!error) count++;
      }
      console.log(`  Announcements: ${count}/${snap.size}`);
    }
  } catch (e) { console.warn('  Announcements error:', e); }
}

async function main(): Promise<void> {
  const targetUid = pickArg('uid');
  const migrateAll = hasFlag('all');
  const dryRun = hasFlag('dry-run');
  const batchSize = Number(pickArg('batch-size')) || 100;
  const skipRoot = hasFlag('skip-root');

  if (!targetUid && !migrateAll) {
    console.error('Usage: --uid <firebase_uid> or --all [--dry-run] [--batch-size N] [--skip-root]');
    process.exit(1);
  }

  console.log('Initializing Firebase...');
  initializeFirebase();
  const db = getFirestore();

  if (targetUid) {
    console.log(`\nMigrating single client: ${targetUid}${dryRun ? ' (DRY RUN)' : ''}`);
    report.total = 1;
    try {
      const ok = await migrateClient(targetUid, dryRun);
      if (ok) report.success++;
      else report.errors.push({ uid: targetUid, error: 'migration returned false' });
    } catch (e: any) {
      console.error(`  ERROR: ${e.message}`);
      report.errors.push({ uid: targetUid, error: e.message });
    }
  } else {
    console.log(`\nMigrating ALL clients${dryRun ? ' (DRY RUN)' : ''} (batch size: ${batchSize})`);
    let lastDoc: FirebaseFirestore.QueryDocumentSnapshot | null = null;
    let pageCount = 0;

    while (true) {
      let q = db.collection('Clients')
        .orderBy('__name__')
        .limit(batchSize);

      if (lastDoc) q = q.startAfter(lastDoc);

      const snap = await q.get();
      if (snap.empty) break;

      pageCount++;
      console.log(`\n--- Page ${pageCount} (${snap.size} clients) ---`);

      for (const doc of snap.docs) {
        report.total++;
        const uid = doc.id;
        console.log(`\n[${report.total}] ${uid}`);
        try {
          const ok = await migrateClient(uid, dryRun);
          if (ok) report.success++;
          else report.errors.push({ uid, error: 'migration returned false' });
        } catch (e: any) {
          console.error(`  ERROR: ${e.message}`);
          report.errors.push({ uid, error: e.message });
        }
      }

      lastDoc = snap.docs[snap.docs.length - 1]!;
      if (snap.size < batchSize) break;
    }
  }

  // Migrate root collections (non-client data)
  if (!skipRoot) {
    await migrateRootCollections(db, dryRun);
  } else {
    console.log('\n[SKIP] Root collections (--skip-root)');
  }

  report.completedAt = new Date().toISOString();

  console.log('\n\n========== MIGRATION REPORT ==========');
  console.log(`Total: ${report.total}`);
  console.log(`Success: ${report.success}`);
  console.log(`Skipped: ${report.skipped}`);
  console.log(`Errors: ${report.errors.length}`);
  if (report.errors.length > 0) {
    console.log('\nFailed UIDs:');
    for (const e of report.errors) {
      console.log(`  - ${e.uid}: ${e.error}`);
    }
  }
  console.log(`\nStarted: ${report.startedAt}`);
  console.log(`Completed: ${report.completedAt}`);

  const { mkdirSync, writeFileSync } = await import('fs');
  const { resolve } = await import('path');
  const outDir = resolve(process.cwd(), 'tmp');
  mkdirSync(outDir, { recursive: true });
  const reportPath = resolve(outDir, `migration-report-${Date.now()}.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(`\nReport written: ${reportPath}`);
  console.log('Done (Firestore was NOT modified).');
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
