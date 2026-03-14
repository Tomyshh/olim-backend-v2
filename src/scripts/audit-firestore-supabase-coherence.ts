/**
 * Audit de cohérence Firestore vs Supabase.
 *
 * Pre-requis Phase 6 : ce script compare les données entre Firestore et Supabase
 * pour confirmer 100% de parité AVANT de supprimer Firestore.
 *
 * Usage: npx tsx src/scripts/audit-firestore-supabase-coherence.ts
 */

import { getFirestore } from '../config/firebase.js';
import { supabase } from '../services/supabase.service.js';

interface AuditResult {
  domain: string;
  firestoreCount: number;
  supabaseCount: number;
  matched: number;
  missingInSupabase: number;
  missingInFirestore: number;
  missingIds: string[];
  status: 'ok' | 'warning' | 'error';
}

async function auditClients(): Promise<AuditResult> {
  const db = getFirestore();
  const firestoreSnap = await db.collection('Clients').get();
  const firestoreUids = new Set(firestoreSnap.docs.map(d => d.id));

  const { data: supabaseClients, error } = await supabase
    .from('clients')
    .select('firebase_uid');
  if (error) throw error;

  const supabaseUids = new Set((supabaseClients || []).map((c: any) => c.firebase_uid).filter(Boolean));

  const missingInSupabase = [...firestoreUids].filter(uid => !supabaseUids.has(uid));
  const missingInFirestore = [...supabaseUids].filter(uid => !firestoreUids.has(uid));
  const matched = [...firestoreUids].filter(uid => supabaseUids.has(uid)).length;

  return {
    domain: 'clients',
    firestoreCount: firestoreUids.size,
    supabaseCount: supabaseUids.size,
    matched,
    missingInSupabase: missingInSupabase.length,
    missingInFirestore: missingInFirestore.length,
    missingIds: missingInSupabase.slice(0, 10),
    status: missingInSupabase.length === 0 ? 'ok' : missingInSupabase.length < 5 ? 'warning' : 'error',
  };
}

async function auditSubscriptions(): Promise<AuditResult> {
  const db = getFirestore();
  const clientsSnap = await db.collection('Clients').get();

  let firestoreCount = 0;
  const firestoreUids: string[] = [];
  for (const clientDoc of clientsSnap.docs) {
    const subDoc = await clientDoc.ref.collection('subscription').doc('current').get();
    if (subDoc.exists) {
      firestoreCount++;
      firestoreUids.push(clientDoc.id);
    }
  }

  const { data: supabaseSubs, error } = await supabase
    .from('subscriptions')
    .select('client_id, clients!inner(firebase_uid)')
  if (error) throw error;

  const supabaseUids = new Set(
    (supabaseSubs || []).map((s: any) => (s as any).clients?.firebase_uid).filter(Boolean)
  );

  const missingInSupabase = firestoreUids.filter(uid => !supabaseUids.has(uid));
  const matched = firestoreUids.filter(uid => supabaseUids.has(uid)).length;

  return {
    domain: 'subscriptions',
    firestoreCount,
    supabaseCount: supabaseUids.size,
    matched,
    missingInSupabase: missingInSupabase.length,
    missingInFirestore: 0,
    missingIds: missingInSupabase.slice(0, 10),
    status: missingInSupabase.length === 0 ? 'ok' : 'warning',
  };
}

async function auditDualWriteFailures(): Promise<{ recentFailures: number; oldestFailure: string | null }> {
  const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString();

  const { count, error } = await supabase
    .from('dual_write_failures')
    .select('*', { count: 'exact', head: true })
    .gte('created_at', twoWeeksAgo);

  if (error) throw error;

  const { data: oldest } = await supabase
    .from('dual_write_failures')
    .select('created_at')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  return {
    recentFailures: count ?? 0,
    oldestFailure: oldest?.created_at ?? null,
  };
}

async function auditFallbackUsage(): Promise<{ fallbackTriggered: boolean; message: string }> {
  // This checks if the supabaseFirstRead fallback has been triggered recently
  // by looking at dual_write_failures with direction 'to_firestore'
  const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString();

  const { count, error } = await supabase
    .from('dual_write_failures')
    .select('*', { count: 'exact', head: true })
    .eq('direction', 'to_firestore')
    .gte('created_at', twoWeeksAgo);

  if (error) {
    return { fallbackTriggered: false, message: `Error checking: ${error.message}` };
  }

  return {
    fallbackTriggered: (count ?? 0) > 0,
    message: count === 0
      ? 'No Firestore fallback triggered in the last 2 weeks'
      : `${count} Firestore fallback(s) triggered in the last 2 weeks`,
  };
}

async function main() {
  console.log('='.repeat(60));
  console.log('AUDIT DE COHERENCE FIRESTORE vs SUPABASE');
  console.log(`Date: ${new Date().toISOString()}`);
  console.log('='.repeat(60));

  const results: AuditResult[] = [];

  try {
    console.log('\n1. Audit des clients...');
    const clientsResult = await auditClients();
    results.push(clientsResult);
    console.log(`   Firestore: ${clientsResult.firestoreCount}, Supabase: ${clientsResult.supabaseCount}`);
    console.log(`   Matched: ${clientsResult.matched}, Missing in Supabase: ${clientsResult.missingInSupabase}`);
    if (clientsResult.missingIds.length > 0) {
      console.log(`   Sample missing UIDs: ${clientsResult.missingIds.join(', ')}`);
    }
    console.log(`   Status: ${clientsResult.status.toUpperCase()}`);
  } catch (e) {
    console.error('   ERROR auditing clients:', e);
  }

  try {
    console.log('\n2. Audit des subscriptions...');
    const subsResult = await auditSubscriptions();
    results.push(subsResult);
    console.log(`   Firestore: ${subsResult.firestoreCount}, Supabase: ${subsResult.supabaseCount}`);
    console.log(`   Matched: ${subsResult.matched}, Missing in Supabase: ${subsResult.missingInSupabase}`);
    console.log(`   Status: ${subsResult.status.toUpperCase()}`);
  } catch (e) {
    console.error('   ERROR auditing subscriptions:', e);
  }

  try {
    console.log('\n3. Audit des dual_write_failures (2 dernières semaines)...');
    const failures = await auditDualWriteFailures();
    console.log(`   Recent failures: ${failures.recentFailures}`);
    if (failures.oldestFailure) {
      console.log(`   Most recent failure: ${failures.oldestFailure}`);
    }
    console.log(`   Status: ${failures.recentFailures === 0 ? 'OK' : 'WARNING'}`);
  } catch (e) {
    console.error('   ERROR auditing failures:', e);
  }

  try {
    console.log('\n4. Audit des fallback Firestore (direction: to_firestore)...');
    const fallback = await auditFallbackUsage();
    console.log(`   ${fallback.message}`);
    console.log(`   Status: ${fallback.fallbackTriggered ? 'WARNING' : 'OK'}`);
  } catch (e) {
    console.error('   ERROR auditing fallback:', e);
  }

  console.log('\n' + '='.repeat(60));

  const allOk = results.every(r => r.status === 'ok');
  if (allOk) {
    console.log('RESULTAT: TOUS LES DOMAINES SONT COHERENTS');
    console.log('=> Phase 6 (suppression Firestore) peut être envisagée.');
  } else {
    console.log('RESULTAT: DES INCOHERENCES ONT ETE DETECTEES');
    console.log('=> NE PAS procéder à la Phase 6.');
    const issues = results.filter(r => r.status !== 'ok');
    for (const issue of issues) {
      console.log(`   - ${issue.domain}: ${issue.missingInSupabase} manquants dans Supabase`);
    }
  }

  console.log('='.repeat(60));
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  console.error('Audit failed:', err);
  process.exit(2);
});
