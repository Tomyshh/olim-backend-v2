/**
 * heal-active-subscription-mismatches.ts
 * ─────────────────────────────────────
 * Corrige prudemment les incohérences du doc `Clients/{uid}/subscription/current` pour les clients
 * dont Firestore indique status=2 (actif) mais `states.isActive === false` (souvent dû à des dates incohérentes).
 *
 * - Détecte les candidats (lecture seule)
 * - Optionnellement: vérifie PayMe (par subCode) pour récupérer status + nextPaymentDate
 * - Réécrit uniquement des champs "safe" (pas de conversion Visitor, pas de changement de plan.membership):
 *   - payme.status (si PayMe renvoie une valeur)
 *   - payme.nextPaymentDate (aligné sur accessUntil calculé)
 *   - dates.endDate (aligné sur accessUntil calculé)
 *   - states.isActive (aligné sur accessUntil)
 *   - states.willExpire uniquement si PayMe dit status=5 (annulé) -> willExpire = stillActive
 *
 * Usage:
 *   tsx scripts/heal-active-subscription-mismatches.ts [--limit N] [--apply]
 */

import dotenv from 'dotenv';
import path from 'path';
import { admin, initializeFirebase, getFirestore } from '../src/config/firebase.js';
import { paymeGetSubscriptionDetails } from '../src/services/payme.service.js';

dotenv.config();
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

function pickArg(name: string): string {
  const idx = process.argv.findIndex((x) => x === `--${name}`);
  if (idx >= 0) return String(process.argv[idx + 1] || '').trim();
  return '';
}

function toDate(value: any): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value?.toDate === 'function') {
    try {
      const d = value.toDate();
      return d instanceof Date && Number.isFinite(d.getTime()) ? d : null;
    } catch {
      return null;
    }
  }
  if (typeof value === 'string') {
    const d = new Date(value);
    return Number.isFinite(d.getTime()) ? d : null;
  }
  if (typeof value?.seconds === 'number') {
    const d = new Date(value.seconds * 1000);
    return Number.isFinite(d.getTime()) ? d : null;
  }
  return null;
}

function coerceStatus(value: any): number | null {
  const n = typeof value === 'string' ? Number(value.trim()) : typeof value === 'number' ? value : NaN;
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function maxDate(dates: Array<Date | null | undefined>): Date | null {
  const valid = dates.filter((d): d is Date => d instanceof Date && Number.isFinite(d.getTime()));
  if (valid.length === 0) return null;
  return new Date(Math.max(...valid.map((d) => d.getTime())));
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const limitRaw = pickArg('limit');
  const limit = limitRaw ? Number(limitRaw) : null;

  console.log('[heal-active-subscription-mismatches] Initializing Firebase...');
  initializeFirebase();
  const db = getFirestore();

  // 1) Charger tous les clientIds (paginé)
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

  const ids = Number.isFinite(limit as any) && (limit as any) > 0 ? allIds.slice(0, Math.trunc(limit as any)) : allIds;
  console.log('[heal-active-subscription-mismatches] clients to scan', { total: allIds.length, scan: ids.length, mode: apply ? 'APPLY' : 'DRY-RUN' });

  const now = new Date();
  const candidates: Array<{ clientId: string; sub: Record<string, any> }> = [];

  // 2) Détecter les candidats: status=2 mais states.isActive === false
  const scanBatchSize = 100;
  for (let i = 0; i < ids.length; i += scanBatchSize) {
    const batch = ids.slice(i, i + scanBatchSize);
    const res = await Promise.all(
      batch.map(async (clientId) => {
        const subSnap = await db.collection('Clients').doc(clientId).collection('subscription').doc('current').get();
        if (!subSnap.exists) return null;
        const sub = (subSnap.data() || {}) as Record<string, any>;
        const status = coerceStatus(sub?.payme?.status) ?? coerceStatus(sub?.status) ?? null;
        const isUnpaid =
          sub?.isUnpaid === true ||
          sub?.states?.isUnpaid === true ||
          String(sub?.status || '').toLowerCase() === 'unpaid' ||
          sub?.payment?.status === 'unpaid';

        // On ne touche pas les cas impayés automatiquement (prudence)
        if (isUnpaid) return null;

        const statesIsActive = sub?.states?.isActive === true;
        const storedEnd = toDate(sub?.dates?.endDate);
        const storedPaymeNext = toDate(sub?.payme?.nextPaymentDate);
        const storedPaymentNext = toDate(sub?.payment?.nextPaymentDate);
        const accessUntilMax = maxDate([storedEnd, storedPaymeNext, storedPaymentNext]);
        const stillActiveByDates = accessUntilMax ? now.getTime() < accessUntilMax.getTime() : null;

        // Candidats:
        // - status=2 mais states.isActive=false
        // - OU status=2 mais les dates indiquent déjà expiré (stillActive=false)
        if (status === 2 && (!statesIsActive || stillActiveByDates === false)) return { clientId, sub };
        return null;
      })
    );
    for (const it of res) if (it) candidates.push(it);
    if ((i + batch.length) % 500 === 0) console.log('[heal-active-subscription-mismatches] scanned', i + batch.length, '/', ids.length);
  }

  console.log('[heal-active-subscription-mismatches] candidates found', { count: candidates.length });
  if (candidates.length === 0) process.exit(0);

  // 3) Pour chaque candidat: appel PayMe (par subCode) et patch Firestore
  const writeBatchSize = 15; // PayMe API calls + Firestore writes: garder prudent
  const changes: Array<{ clientId: string; before: any; after: any; reason: string }> = [];

  for (let i = 0; i < candidates.length; i += writeBatchSize) {
    const batch = candidates.slice(i, i + writeBatchSize);
    const ops = await Promise.all(
      batch.map(async ({ clientId, sub }) => {
        const paymeSubCode = sub?.payme?.subCode ?? null;
        const storedEnd = toDate(sub?.dates?.endDate);
        const storedPaymeNext = toDate(sub?.payme?.nextPaymentDate);
        const storedPaymentNext = toDate(sub?.payment?.nextPaymentDate);

        const before = {
          paymeStatus: coerceStatus(sub?.payme?.status),
          paymeSubCode,
          endDate: storedEnd?.toISOString() ?? null,
          paymeNext: storedPaymeNext?.toISOString() ?? null,
          paymentNext: storedPaymentNext?.toISOString() ?? null,
          statesIsActive: sub?.states?.isActive ?? null,
          statesWillExpire: sub?.states?.willExpire ?? null,
          planMembership: sub?.plan?.membership ?? null
        };

        // Si pas de subCode, on ne peut pas consulter PayMe -> skip
        if (paymeSubCode == null) {
          return { clientId, before, after: null, reason: 'skip:no_subCode' } as const;
        }

        const details = await paymeGetSubscriptionDetails({ subCode: paymeSubCode });
        const paymeStatusFromPayme = details?.subStatus ?? null;
        const nextFromPayme = details?.nextPaymentDate ?? null;

        // On aligne accessUntil sur la date la plus tardive connue (Firestore + PayMe)
        const accessUntil = maxDate([storedEnd, storedPaymeNext, storedPaymentNext, nextFromPayme]);
        const stillActive = accessUntil ? now.getTime() < accessUntil.getTime() : false;

        // Patches "safe"
        const patch: Record<string, any> = {
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          dates: { ...(sub?.dates || {}), ...(accessUntil ? { endDate: accessUntil } : {}) },
          payme: { ...(sub?.payme || {}), ...(paymeStatusFromPayme != null ? { status: paymeStatusFromPayme } : {}) }
        };
        if (accessUntil) {
          patch.payme = { ...(patch.payme || {}), nextPaymentDate: accessUntil };
        }
        patch.states = { ...(sub?.states || {}), isActive: stillActive };
        if (paymeStatusFromPayme === 5) {
          patch.states = { ...(patch.states || {}), willExpire: stillActive };
        }

        const after = {
          paymeStatus: paymeStatusFromPayme,
          accessUntil: accessUntil?.toISOString() ?? null,
          stillActive,
          patchPreview: {
            payme: {
              status: paymeStatusFromPayme,
              nextPaymentDate: accessUntil?.toISOString?.() ?? null
            },
            dates: { endDate: accessUntil?.toISOString?.() ?? null },
            states: { isActive: stillActive, ...(paymeStatusFromPayme === 5 ? { willExpire: stillActive } : {}) }
          }
        };

        if (apply) {
          await db.collection('Clients').doc(clientId).collection('subscription').doc('current').set(patch, { merge: true });
        }
        return { clientId, before, after, reason: apply ? 'applied' : 'dry_run' } as const;
      })
    );

    changes.push(...ops);
    console.log('[heal-active-subscription-mismatches] processed', Math.min(i + writeBatchSize, candidates.length), '/', candidates.length);
  }

  const applied = changes.filter((c) => c.reason === 'applied').length;
  const skippedNoSubCode = changes.filter((c) => c.reason === 'skip:no_subCode').length;
  const paymeTo5 = changes.filter((c) => c.after?.paymeStatus === 5).length;
  const paymeTo2 = changes.filter((c) => c.after?.paymeStatus === 2).length;

  console.log('\n' + '─'.repeat(80));
  console.log('[heal-active-subscription-mismatches] DONE', {
    mode: apply ? 'APPLY' : 'DRY-RUN',
    candidates: candidates.length,
    applied,
    skippedNoSubCode,
    paymeStatusTo5: paymeTo5,
    paymeStatusTo2: paymeTo2
  });

  // Afficher un petit échantillon
  const sample = changes.filter((c) => c.after != null).slice(0, 20);
  if (sample.length > 0) {
    console.log('\nSample (first 20):');
    for (const s of sample) {
      console.log('-', s.clientId, s.before?.paymeStatus, '->', s.after?.paymeStatus, 'accessUntil:', s.after?.accessUntil);
    }
  }
}

main().catch((e) => {
  console.error('[heal-active-subscription-mismatches] failed', { error: String(e?.message || e) });
  process.exit(1);
});

