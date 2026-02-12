/**
 * Inspecte la fiche client et subscription/current pour un clientId donné.
 * Affiche les champs utilisés par GET /api/subscription/status et simule
 * la condition de conversion en Visitor.
 *
 * Usage: tsx scripts/inspect-client-subscription.ts <clientId>
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

async function main(): Promise<void> {
  const clientId = process.argv[2]?.trim();
  if (!clientId) {
    console.error('Usage: tsx scripts/inspect-client-subscription.ts <clientId>');
    process.exit(1);
  }

  console.log('[inspect-client-subscription] Initializing Firebase...');
  initializeFirebase();
  const db = getFirestore();

  const clientRef = db.collection('Clients').doc(clientId);
  const subRef = clientRef.collection('subscription').doc('current');

  const [clientSnap, subSnap] = await Promise.all([clientRef.get(), subRef.get()]);

  if (!clientSnap.exists) {
    console.error('Client non trouvé:', clientId);
    process.exit(1);
  }

  const client = clientSnap.data() || {};
  const sub = subSnap.exists ? (subSnap.data() || {}) : null;

  console.log('\n=== Client', clientId, '===');
  console.log('Email:', (client as any).Email ?? '(vide)');
  console.log('Membership (doc principal):', (client as any).Membership ?? '(vide)');

  if (!sub) {
    console.log('\nsubscription/current: ABSENT → l\'app considère le user comme Visitor (pas d\'abonnement).');
    process.exit(0);
  }

  const paymeObj = (sub as any).payme || {};
  const storedSubStatus =
    coerceIntOrNull(paymeObj.status) ?? coerceIntOrNull(paymeObj.sub_status) ?? coerceIntOrNull(paymeObj.subStatus);
  const storedEndDate = toDate((sub as any).dates?.endDate);
  const storedNextPaymentDate = toDate(paymeObj.nextPaymentDate);
  const storedPaymentNext = toDate((sub as any).payment?.nextPaymentDate);
  const membership = pickString((sub as any).plan?.membership) || pickString((sub as any).membership) || '';
  const isVisitor = membership.trim().toLowerCase() === 'visitor';

  console.log('\n--- subscription/current (champs lus par GET /subscription/status) ---');
  console.log('plan.membership:', (sub as any).plan?.membership ?? '(vide)');
  console.log('plan.type:', (sub as any).plan?.type ?? '(vide)');
  console.log('states.isActive:', (sub as any).states?.isActive);
  console.log('states.willExpire:', (sub as any).states?.willExpire);
  console.log('payme.subCode:', paymeObj.subCode ?? '(vide)');
  console.log('payme.subID:', paymeObj.subID ?? '(vide)');
  console.log('payme.status (stocké):', paymeObj.status ?? '(vide)');
  console.log('payme.sub_status:', paymeObj.sub_status ?? '(vide)');
  console.log('payme.nextPaymentDate:', storedNextPaymentDate ? storedNextPaymentDate.toISOString() : '(vide)');
  console.log('dates.endDate:', storedEndDate ? storedEndDate.toISOString() : '(vide)');
  console.log('payment.nextPaymentDate:', storedPaymentNext ? storedPaymentNext.toISOString() : '(vide)');
  console.log('updatedAt:', (sub as any).updatedAt?.toDate?.()?.toISOString?.() ?? (sub as any).updatedAt ?? '(vide)');

  // Logique identique à getSubscriptionStatus (sans appel PayMe pour rester en lecture seule)
  const paymeSubStatus = storedSubStatus; // sans details PayMe ici
  const accessUntil = storedEndDate || storedNextPaymentDate || storedPaymentNext || null;

  const now = new Date();
  const stillActive = accessUntil ? now.getTime() < accessUntil.getTime() : null;
  const conversionCondition =
    paymeSubStatus === 5 && accessUntil && now.getTime() >= accessUntil.getTime() && !isVisitor;

  console.log('\n--- Simulation GET /subscription/status (sans appel PayMe) ---');
  console.log('paymeSubStatus (utilisé):', paymeSubStatus, paymeSubStatus === 5 ? '(5 = annulé)' : paymeSubStatus === 2 ? '(2 = actif)' : '');
  console.log('accessUntil (date utilisée):', accessUntil ? accessUntil.toISOString() : '(vide)');
  console.log('now:', now.toISOString());
  console.log('stillActive (now < accessUntil):', stillActive);
  console.log('Conversion Visitor déclenchée?:', conversionCondition);

  if (conversionCondition) {
    console.log('\n>>> CAUSE: La conversion est déclenchée car TOUTES ces conditions sont vraies:');
    console.log('   - paymeSubStatus === 5 (abonnement considéré annulé)');
    console.log('   - accessUntil existe et now >= accessUntil (date dans le passé)');
    console.log('   - membership !== Visitor');
    console.log('\nPour un client actif à jour, soit Firestore a status=5 à tort, soit la date endDate/nextPaymentDate est dans le passé (ou mauvais subCode = ancien abonnement annulé côté PayMe).');
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
