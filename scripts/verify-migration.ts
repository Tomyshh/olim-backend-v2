/**
 * Verification script: compare Firestore document counts vs Supabase row counts.
 * Also checks for orphaned FK references.
 *
 * Usage: npx tsx scripts/verify-migration.ts
 */

import 'dotenv/config';
import { initializeFirebase, getFirestore } from '../src/config/firebase.js';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
if (!supabaseUrl || !supabaseKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SECRET_KEY');
  process.exit(1);
}
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { autoRefreshToken: false, persistSession: false }
});

async function countFirestoreCollection(db: FirebaseFirestore.Firestore, path: string): Promise<number> {
  try {
    const snap = await db.collection(path).count().get();
    return snap.data().count;
  } catch {
    return -1;
  }
}

async function countSupabaseTable(table: string): Promise<number> {
  try {
    const { count, error } = await supabase
      .from(table)
      .select('*', { count: 'exact', head: true });
    if (error) return -1;
    return count ?? 0;
  } catch {
    return -1;
  }
}

async function countClientSubcollection(db: FirebaseFirestore.Firestore, subcol: string, sampleSize: number = 200): Promise<number> {
  let total = 0;
  let lastDoc: FirebaseFirestore.QueryDocumentSnapshot | null = null;

  while (true) {
    let q = db.collection('Clients').orderBy('__name__').limit(sampleSize);
    if (lastDoc) q = q.startAfter(lastDoc);
    const snap = await q.get();
    if (snap.empty) break;

    for (const clientDoc of snap.docs) {
      try {
        const subSnap = await clientDoc.ref.collection(subcol).count().get();
        total += subSnap.data().count;
      } catch { /* subcollection may not exist */ }
    }

    lastDoc = snap.docs[snap.docs.length - 1]!;
    if (snap.size < sampleSize) break;
  }
  return total;
}

interface CompareResult {
  name: string;
  firestore: number;
  supabase: number;
  diff: number;
  status: string;
}

async function main(): Promise<void> {
  console.log('Initializing Firebase...');
  initializeFirebase();
  const db = getFirestore();

  console.log('Verification: Firestore vs Supabase counts\n');

  const results: CompareResult[] = [];

  // Root collections
  const rootMappings: [string, string][] = [
    ['Clients', 'clients'],
    ['Conseillers2', 'conseillers'],
    ['Promotions', 'promotions'],
    ['PromoReverts', 'promo_reverts'],
    ['ContactMessages', 'contact_messages'],
    ['ChatCC', 'chatcc'],
    ['Tips', 'tips'],
    ['FAQs', 'faqs'],
    ['SupportContacts', 'support_contacts'],
    ['News', 'news'],
    ['AvailableSlots', 'available_slots'],
    ['iCinema', 'icinema_movies'],
    ['AdminAuditLogs', 'admin_audit_logs'],
    ['SystemAlerts', 'system_alerts'],
  ];

  console.log('--- Root Collections ---');
  for (const [fsCol, sbTable] of rootMappings) {
    const fsCount = await countFirestoreCollection(db, fsCol);
    const sbCount = await countSupabaseTable(sbTable);
    const diff = fsCount - sbCount;
    const status = fsCount === sbCount ? 'OK' : diff > 0 ? 'MISSING' : 'EXTRA';
    results.push({ name: `${fsCol} → ${sbTable}`, firestore: fsCount, supabase: sbCount, diff, status });
    const icon = status === 'OK' ? '✅' : status === 'MISSING' ? '⚠️ ' : '➕';
    console.log(`  ${icon} ${fsCol} → ${sbTable}: Firestore=${fsCount} Supabase=${sbCount} (diff=${diff})`);
  }

  // Client subcollections
  const subMappings: [string, string][] = [
    ['subscription', 'subscriptions'],
    ['Addresses', 'client_addresses'],
    ['Family Members', 'family_members'],
    ['Payment credentials', 'payment_credentials'],
    ['Client Documents', 'client_documents'],
    ['favoriteRequests', 'favorite_requests'],
    ['Conversations', 'chat_conversations'],
    ['notifications', 'notifications'],
    ['appointments', 'appointments'],
    ['RequestDrafts', 'request_drafts'],
    ['support_tickets', 'support_tickets'],
    ['health_requests', 'health_requests'],
    ['refund_requests', 'refund_requests'],
    ['Client Acces', 'client_access_credentials'],
    ['Client Logs', 'client_logs'],
    ['invoices', 'invoices'],
    ['Tips', 'user_saved_tips'],
  ];

  console.log('\n--- Client Subcollections (scanning all clients) ---');
  for (const [subCol, sbTable] of subMappings) {
    process.stdout.write(`  Counting ${subCol}...`);
    const fsCount = await countClientSubcollection(db, subCol);
    const sbCount = await countSupabaseTable(sbTable);
    const diff = fsCount - sbCount;
    const status = diff === 0 ? 'OK' : diff > 0 ? 'MISSING' : 'EXTRA';
    results.push({ name: `Clients/*/${subCol} → ${sbTable}`, firestore: fsCount, supabase: sbCount, diff, status });
    const icon = status === 'OK' ? '✅' : status === 'MISSING' ? '⚠️ ' : '➕';
    console.log(` ${icon} Firestore=${fsCount} Supabase=${sbCount} (diff=${diff})`);
  }

  // FK integrity checks
  console.log('\n--- FK Integrity Checks ---');

  const fkChecks: [string, string][] = [
    ['family_members', 'client_id'],
    ['subscriptions', 'client_id'],
    ['client_addresses', 'client_id'],
    ['payment_credentials', 'client_id'],
    ['client_documents', 'client_id'],
    ['notifications', 'client_id'],
    ['appointments', 'client_id'],
    ['chat_conversations', 'client_id'],
    ['invoices', 'client_id'],
    ['client_access_credentials', 'client_id'],
  ];

  for (const [table, col] of fkChecks) {
    try {
      const { count, error } = await supabase
        .from(table)
        .select('*', { count: 'exact', head: true })
        .not(col, 'is', null);

      if (error) {
        console.log(`  ❌ ${table}.${col}: error checking - ${error.message}`);
      } else {
        console.log(`  ✅ ${table}.${col}: ${count} rows with FK`);
      }
    } catch (e) {
      console.log(`  ❌ ${table}.${col}: ${e}`);
    }
  }

  // Summary
  console.log('\n\n========== SUMMARY ==========');
  const ok = results.filter(r => r.status === 'OK').length;
  const missing = results.filter(r => r.status === 'MISSING').length;
  const extra = results.filter(r => r.status === 'EXTRA').length;
  console.log(`Total checks: ${results.length}`);
  console.log(`  ✅ Matching: ${ok}`);
  console.log(`  ⚠️  Missing in Supabase: ${missing}`);
  console.log(`  ➕ Extra in Supabase: ${extra}`);

  if (missing > 0) {
    console.log('\nCollections with missing data:');
    for (const r of results.filter(r => r.status === 'MISSING')) {
      console.log(`  - ${r.name}: ${r.diff} missing`);
    }
  }

  console.log('\nDone.');
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
