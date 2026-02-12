/**
 * Inspecte la fiche client et subscription/current pour un clientId donné ou tous les clients.
 * Affiche les champs utilisés par GET /api/subscription/status et simule la condition de conversion en Visitor.
 *
 * Usage:
 *   tsx scripts/inspect-client-subscription.ts <clientId>
 *   tsx scripts/inspect-client-subscription.ts --all [--limit N]
 */

import dotenv from 'dotenv';
import path from 'path';
import { initializeFirebase, getFirestore } from '../src/config/firebase.js';
import admin from 'firebase-admin';

dotenv.config();
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

function toDate(value: any): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  const ts = admin.firestore?.Timestamp;
  if (ts && value instanceof ts) return value.toDate();
  if (typeof value?.toDate === 'function') return value.toDate();
  if (typeof value === 'string') {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d;
  }
  if (value && typeof value.seconds === 'number') return new Date(value.seconds * 1000);
  return null;
}

function coerceIntOrNull(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value.trim()) : typeof value === 'number' ? value : NaN;
  return Number.isFinite(n) ? Math.floor(n) : null;
}

function pickString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

type InspectResult = {
  clientId: string;
  email: string;
  membership: string;
  hasSubDoc: boolean;
  planMembership: string | null;
  paymeStatus: number | null;
  accessUntil: Date | null;
  stillActive: boolean | null;
  conversionTriggered: boolean;
  /** endDate dans le passé alors que nextPaymentDate dans le futur (bug corrigé côté API) */
  inconsistentDates: boolean;
};

function inspectOne(clientId: string, client: Record<string, any>, sub: Record<string, any> | null, now: Date): InspectResult {
  const email = String((client as any).Email ?? '').trim();
  const membership = String((client as any).Membership ?? '').trim();
  if (!sub) {
    return {
      clientId,
      email,
      membership,
      hasSubDoc: false,
      planMembership: null,
      paymeStatus: null,
      accessUntil: null,
      stillActive: null,
      conversionTriggered: false,
      inconsistentDates: false
    };
  }
  const paymeObj = (sub as any).payme || {};
  const storedSubStatus =
    coerceIntOrNull(paymeObj.status) ?? coerceIntOrNull(paymeObj.sub_status) ?? coerceIntOrNull(paymeObj.subStatus);
  const storedEndDate = toDate((sub as any).dates?.endDate);
  const storedNextPaymentDate = toDate(paymeObj.nextPaymentDate);
  const storedPaymentNext = toDate((sub as any).payment?.nextPaymentDate);
  const planMembership = pickString((sub as any).plan?.membership) || pickString((sub as any).membership) || null;
  const isVisitor = (planMembership || '').trim().toLowerCase() === 'visitor';

  const accessUntil = storedEndDate || storedNextPaymentDate || storedPaymentNext || null;
  const stillActiveVal = accessUntil ? now.getTime() < accessUntil.getTime() : null;
  const conversionTriggered = Boolean(
    storedSubStatus === 5 && accessUntil && now.getTime() >= accessUntil.getTime() && !isVisitor
  );

  const endDatePast = storedEndDate != null && now.getTime() >= storedEndDate.getTime();
  const nextPaymentFuture =
    (storedNextPaymentDate != null && now.getTime() < storedNextPaymentDate.getTime()) ||
    (storedPaymentNext != null && now.getTime() < storedPaymentNext.getTime());
  const inconsistentDates = endDatePast && nextPaymentFuture;

  const result: InspectResult = {
    clientId,
    email,
    membership,
    hasSubDoc: true,
    planMembership: planMembership || null,
    paymeStatus: storedSubStatus ?? null,
    accessUntil,
    stillActive: stillActiveVal,
    conversionTriggered,
    inconsistentDates
  };
  return result;
}

async function runOne(clientId: string): Promise<void> {
  const db = getFirestore();
  const clientRef = db.collection('Clients').doc(clientId);
  const subRef = clientRef.collection('subscription').doc('current');
  const [clientSnap, subSnap] = await Promise.all([clientRef.get(), subRef.get()]);
  if (!clientSnap.exists) {
    console.error('Client non trouvé:', clientId);
    return;
  }
  const client = clientSnap.data() || {};
  const sub = subSnap.exists ? (subSnap.data() || {}) : null;
  const now = new Date();

  console.log('\n=== Client', clientId, '===');
  console.log('Email:', (client as any).Email ?? '(vide)');
  console.log('Membership (doc principal):', (client as any).Membership ?? '(vide)');
  if (!sub) {
    console.log('\nsubscription/current: ABSENT → Visitor.');
    return;
  }
  const r = inspectOne(clientId, client as Record<string, any>, sub as Record<string, any>, now);
  console.log('\n--- subscription/current ---');
  console.log('plan.membership:', (sub as any).plan?.membership ?? '(vide)');
  console.log('states.isActive:', (sub as any).states?.isActive);
  console.log('payme.status:', (sub as any).payme?.status ?? '(vide)');
  console.log('dates.endDate:', toDate((sub as any).dates?.endDate)?.toISOString() ?? '(vide)');
  console.log('payment.nextPaymentDate:', toDate((sub as any).payment?.nextPaymentDate)?.toISOString() ?? '(vide)');
  console.log('accessUntil (simulé):', r.accessUntil?.toISOString() ?? '(vide)');
  console.log('stillActive:', r.stillActive);
  console.log('Conversion Visitor déclenchée?:', r.conversionTriggered);
  if (r.inconsistentDates) console.log('>>> Dates incohérentes (endDate passée + nextPaymentDate future)');
}

async function runAll(limit: number | null): Promise<void> {
  const db = getFirestore();
  const docIdField = admin.firestore.FieldPath.documentId();
  const pageSize = 250;
  let lastDoc: FirebaseFirestore.QueryDocumentSnapshot | null = null;
  const allIds: string[] = [];
  do {
    let q: FirebaseFirestore.Query = db.collection('Clients').orderBy(docIdField).limit(pageSize);
    if (lastDoc) q = q.startAfter(lastDoc);
    const snap = await q.get();
    for (const d of snap.docs) allIds.push(d.id);
    if (snap.docs.length > 0) lastDoc = snap.docs[snap.docs.length - 1];
    if (snap.docs.length < pageSize) break;
  } while (true);

  const limitedIds = limit != null ? allIds.slice(0, limit) : allIds;
  console.log('[inspect-client-subscription] --all: total clients', allIds.length, limit != null ? `, limit ${limit} → ${limitedIds.length}` : '');

  const now = new Date();
  const results: InspectResult[] = [];
  const batchSize = 80;
  for (let i = 0; i < limitedIds.length; i += batchSize) {
    const batch = limitedIds.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(async (clientId) => {
        const clientRef = db.collection('Clients').doc(clientId);
        const subRef = clientRef.collection('subscription').doc('current');
        const [clientSnap, subSnap] = await Promise.all([clientRef.get(), subRef.get()]);
        if (!clientSnap.exists) return null;
        const client = clientSnap.data() || {};
        const sub = subSnap.exists ? (subSnap.data() || {}) : null;
        return inspectOne(clientId, client as Record<string, any>, sub as Record<string, any>, now);
      })
    );
    for (const r of batchResults) if (r) results.push(r);
    if (i + batch.length >= limitedIds.length) console.log('[inspect-client-subscription] traité', limitedIds.length, '/', limitedIds.length);
    else console.log('[inspect-client-subscription] traité', Math.min(i + batchSize, limitedIds.length), '/', limitedIds.length);
  }

  const withSub = results.filter((r) => r.hasSubDoc);
  const conversion = results.filter((r) => r.conversionTriggered);
  const inconsistent = results.filter((r) => r.inconsistentDates);
  const activeButStillActiveFalse = results.filter(
    (r) => r.hasSubDoc && r.paymeStatus === 2 && r.accessUntil && r.stillActive === false
  );

  console.log('\n' + '─'.repeat(60));
  console.log('RÉSUMÉ');
  console.log('─'.repeat(60));
  console.log('Total clients:', results.length);
  console.log('Avec subscription/current:', withSub.length);
  console.log('Conversion Visitor déclenchée (status=5 + date passée):', conversion.length);
  console.log('Dates incohérentes (endDate passée + nextPaymentDate future):', inconsistent.length);
  console.log('Actifs (status=2) mais stillActive=false (impactés par le bug):', activeButStillActiveFalse.length);

  if (conversion.length > 0) {
    console.log('\n--- Clients pour lesquels la conversion serait déclenchée ---');
    conversion.forEach((r) => console.log(r.clientId, r.email || '(email vide)', r.planMembership, r.accessUntil?.toISOString()));
  }
  if (inconsistent.length > 0) {
    console.log('\n--- Clients avec dates incohérentes ---');
    inconsistent.forEach((r) => console.log(r.clientId, r.email || '(email vide)', 'endDate passée, nextPaymentDate future'));
  }
  if (activeButStillActiveFalse.length > 0) {
    console.log('\n--- Actifs (status=2) avec stillActive=false ---');
    activeButStillActiveFalse.forEach((r) => console.log(r.clientId, r.email || '(email vide)', r.accessUntil?.toISOString()));
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const all = args.includes('--all');
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx >= 0 && args[limitIdx + 1] ? parseInt(args[limitIdx + 1], 10) : null;
  const clientId = !all ? args[0]?.trim() : null;

  if (!all && !clientId) {
    console.error('Usage: tsx scripts/inspect-client-subscription.ts <clientId>');
    console.error('       tsx scripts/inspect-client-subscription.ts --all [--limit N]');
    process.exit(1);
  }

  console.log('[inspect-client-subscription] Initializing Firebase...');
  initializeFirebase();

  if (all) {
    await runAll(Number.isFinite(limit) && limit! > 0 ? limit! : null);
  } else {
    await runOne(clientId!);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
