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
  mapAppointmentToSupabase
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
      const subRow = mapSubscriptionToSupabase(clientId, subSnap.data()!);
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
      const row = mapFamilyMemberToSupabase(clientId, doc.id, doc.data());
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
      const docId = await insertRow('client_documents', {
        client_id: clientId,
        document_type: d['Document Type'] || d.documentType || 'unknown',
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

  return true;
}

async function main(): Promise<void> {
  const targetUid = pickArg('uid');
  const migrateAll = hasFlag('all');
  const dryRun = hasFlag('dry-run');
  const batchSize = Number(pickArg('batch-size')) || 100;

  if (!targetUid && !migrateAll) {
    console.error('Usage: --uid <firebase_uid> or --all [--dry-run] [--batch-size N]');
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
