/**
 * migrate-promo-format.ts
 *
 * Script de migration qui normalise le format des données promo dans
 * Clients/{uid}/subscription/current pour tous les clients.
 *
 * Format cible (identique CRM) :
 *
 *   promoCode: {
 *     code: string,           // code normalisé (ex: "INGRID15")
 *     reduction: number,      // pourcentage (ex: 15)
 *     appliedDate: string,    // ISO 8601
 *     expirationDate: string | null,
 *     source: string          // = code normalisé
 *   }
 *
 *   pricing: {
 *     basePriceInCents: number,
 *     discountInCents: number,
 *     chargedPriceInCents: number,
 *     pricingSource: "promo_applied",
 *     membershipTypeNormalized: string,
 *     planNormalized: "monthly" | "annual",
 *     promo: {
 *       promoCode: string,
 *       promotionId: string,
 *       discountType: "percent" | "amount",
 *       discountValue: number,
 *       expiresAt: Date | null,
 *       durationCycles: number | null,
 *       appliedAt: Timestamp,
 *       revertAt: Date | null
 *     }
 *   }
 *
 * Usage:
 *   npx tsx scripts/migrate-promo-format.ts --limit 5                  # dry-run 5 clients
 *   npx tsx scripts/migrate-promo-format.ts --uid ABC123               # dry-run 1 client
 *   npx tsx scripts/migrate-promo-format.ts --all --limit 10           # dry-run 10
 *   npx tsx scripts/migrate-promo-format.ts --all --limit 10 --commit  # applique sur 10
 *   npx tsx scripts/migrate-promo-format.ts --all --commit             # TOUT migrer
 */

import { initializeFirebase, getFirestore, admin } from '../src/config/firebase.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DetectedPromo {
  code: string;
  reduction: number | null;
  discountType: 'percent' | 'amount' | null;
  expirationDate: Date | null;
  appliedDate: string | null;
  source: string | null;
  promotionId: string | null;
  durationCycles: number | null;
  revertAt: Date | null;
  revertedAt: any;
  basePriceInCents: number | null;
  chargedPriceInCents: number | null;
  discountInCents: number | null;
}

type MigrationAction = 'skip_no_promo' | 'skip_already_migrated' | 'skip_reverted' | 'migrate' | 'error';

interface MigrationResult {
  uid: string;
  action: MigrationAction;
  detectedFormat: string;
  detected: DetectedPromo | null;
  detail: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pickString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function toDateOrNull(value: any): Date | null {
  if (!value) return null;
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  if (value && typeof value === 'object' && typeof value.toDate === 'function') {
    try {
      const d = value.toDate();
      return d instanceof Date && Number.isFinite(d.getTime()) ? d : null;
    } catch { return null; }
  }
  if (typeof value === 'object') {
    const seconds = (value as any).seconds ?? (value as any)._seconds;
    if (typeof seconds === 'number' && Number.isFinite(seconds)) {
      const d = new Date(seconds * 1000);
      return Number.isFinite(d.getTime()) ? d : null;
    }
  }
  if (typeof value === 'string' && value.trim()) {
    const d = new Date(value.trim());
    return Number.isFinite(d.getTime()) ? d : null;
  }
  return null;
}

function digitsOnlyUpper(value: unknown): string {
  const s = pickString(value);
  if (!s) return '';
  return s.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}

// ---------------------------------------------------------------------------
// Détection intelligente du format existant
// ---------------------------------------------------------------------------

function detectPromoFromSubscription(
  sub: Record<string, any>,
  clientDoc: Record<string, any> | null
): { format: string; promo: DetectedPromo | null } {

  const promoCodeField = sub.promoCode;
  const pricingField = sub.pricing;
  const pricingPromo = pricingField?.promo;

  // ------ Format cible (nouveau) : promoCode = objet + pricing.promo = objet ------
  if (
    promoCodeField && typeof promoCodeField === 'object' && !Array.isArray(promoCodeField) &&
    pickString(promoCodeField.code) &&
    pricingPromo && typeof pricingPromo === 'object' && pickString(pricingPromo.promoCode)
  ) {
    return { format: 'new_standard', promo: null }; // Déjà au bon format
  }

  // ------ Format string simple : promoCode = "INGRID15" (ancien CRM) ------
  if (typeof promoCodeField === 'string' && promoCodeField.trim()) {
    const code = digitsOnlyUpper(promoCodeField);
    return {
      format: 'legacy_string',
      promo: {
        code,
        reduction: null,
        discountType: null,
        expirationDate: null,
        appliedDate: toDateOrNull(sub.createdAt)?.toISOString() || null,
        source: code,
        promotionId: null,
        durationCycles: null,
        revertAt: null,
        revertedAt: null,
        basePriceInCents: Number(sub.plan?.basePriceInCents) || Number(sub.plan?.price) || null,
        chargedPriceInCents: Number(sub.plan?.price) || null,
        discountInCents: null
      }
    };
  }

  // ------ Format app ancien : pricing.promo existe mais pas promoCode top-level ------
  if (
    pricingPromo && typeof pricingPromo === 'object' && pickString(pricingPromo.promoCode) &&
    (!promoCodeField || typeof promoCodeField !== 'object')
  ) {
    const code = digitsOnlyUpper(pricingPromo.promoCode);
    return {
      format: 'app_no_toplevel',
      promo: {
        code,
        reduction: typeof pricingPromo.discountValue === 'number' ? pricingPromo.discountValue : null,
        discountType: pricingPromo.discountType || null,
        expirationDate: toDateOrNull(pricingPromo.expiresAt),
        appliedDate: toDateOrNull(pricingPromo.appliedAt)?.toISOString() || toDateOrNull(sub.createdAt)?.toISOString() || null,
        source: code,
        promotionId: pickString(pricingPromo.promotionId) || null,
        durationCycles: typeof pricingPromo.durationCycles === 'number' ? pricingPromo.durationCycles : null,
        revertAt: toDateOrNull(pricingPromo.revertAt),
        revertedAt: pricingPromo.revertedAt || null,
        basePriceInCents: Number(pricingField?.basePriceInCents) || Number(sub.plan?.basePriceInCents) || null,
        chargedPriceInCents: Number(pricingField?.chargedPriceInCents) || Number(sub.plan?.price) || null,
        discountInCents: Number(pricingField?.discountInCents) || null
      }
    };
  }

  // ------ pricing avec champs extra mais promoCode déjà objet (partiellement migré?) ------
  if (
    promoCodeField && typeof promoCodeField === 'object' && pickString(promoCodeField.code) &&
    (!pricingPromo || !pickString(pricingPromo?.promoCode))
  ) {
    const code = digitsOnlyUpper(promoCodeField.code);
    return {
      format: 'toplevel_only_no_pricing_promo',
      promo: {
        code,
        reduction: typeof promoCodeField.reduction === 'number' ? promoCodeField.reduction : null,
        discountType: 'percent',
        expirationDate: toDateOrNull(promoCodeField.expirationDate),
        appliedDate: pickString(promoCodeField.appliedDate) || toDateOrNull(sub.createdAt)?.toISOString() || null,
        source: pickString(promoCodeField.source) || code,
        promotionId: null,
        durationCycles: null,
        revertAt: null,
        revertedAt: null,
        basePriceInCents: Number(pricingField?.basePriceInCents) || Number(sub.plan?.basePriceInCents) || Number(sub.plan?.price) || null,
        chargedPriceInCents: Number(pricingField?.chargedPriceInCents) || Number(sub.plan?.price) || null,
        discountInCents: Number(pricingField?.discountInCents) || null
      }
    };
  }

  // ------ Pas de promo dans subscription, vérifier le doc Clients ------
  if (clientDoc) {
    const promoUsed = pickString(clientDoc.promoCodeUsed);
    if (promoUsed) {
      const code = digitsOnlyUpper(promoUsed);
      return {
        format: 'client_doc_only',
        promo: {
          code,
          reduction: null,
          discountType: null,
          expirationDate: toDateOrNull(clientDoc.codePromoExpirationDate),
          appliedDate: toDateOrNull(sub.createdAt)?.toISOString() || toDateOrNull(clientDoc['Created At'])?.toISOString() || null,
          source: code,
          promotionId: null,
          durationCycles: null,
          revertAt: null,
          revertedAt: null,
          basePriceInCents: Number(sub.plan?.basePriceInCents) || Number(sub.plan?.price) || null,
          chargedPriceInCents: Number(sub.plan?.price) || null,
          discountInCents: null
        }
      };
    }
  }

  return { format: 'no_promo', promo: null };
}

// ---------------------------------------------------------------------------
// Enrichissement depuis la collection Promotions
// ---------------------------------------------------------------------------

// Cache in-memory pour éviter de relire les mêmes promos
const promoCache = new Map<string, Record<string, any> | null>();

async function loadPromotionByCode(db: FirebaseFirestore.Firestore, codeNormalized: string): Promise<{ id: string; data: Record<string, any> } | null> {
  if (promoCache.has(codeNormalized)) {
    const cached = promoCache.get(codeNormalized);
    return cached ? { id: codeNormalized, data: cached } : null;
  }

  // 1) docId direct
  const byId = await db.collection('Promotions').doc(codeNormalized).get().catch(() => null as any);
  if (byId?.exists) {
    const data = (byId.data() || {}) as Record<string, any>;
    promoCache.set(codeNormalized, data);
    return { id: byId.id, data };
  }

  // 2) where codeNormalized
  const snap = await db.collection('Promotions').where('codeNormalized', '==', codeNormalized).limit(1).get().catch(() => null as any);
  if (snap && !snap.empty) {
    const d = snap.docs[0]!;
    const data = (d.data() || {}) as Record<string, any>;
    promoCache.set(codeNormalized, data);
    return { id: d.id, data };
  }

  // 3) where code
  const snap2 = await db.collection('Promotions').where('code', '==', codeNormalized).limit(1).get().catch(() => null as any);
  if (snap2 && !snap2.empty) {
    const d = snap2.docs[0]!;
    const data = (d.data() || {}) as Record<string, any>;
    promoCache.set(codeNormalized, data);
    return { id: d.id, data };
  }

  promoCache.set(codeNormalized, null);
  return null;
}

async function enrichFromPromotions(
  db: FirebaseFirestore.Firestore,
  detected: DetectedPromo,
  sub: Record<string, any>
): Promise<{ enriched: DetectedPromo; promoFoundInDb: boolean }> {
  if (!detected.code) return { enriched: detected, promoFoundInDb: false };

  const promo = await loadPromotionByCode(db, detected.code);
  if (!promo) return { enriched: detected, promoFoundInDb: false };

  const doc = promo.data;
  const enriched = { ...detected };

  // Remplir les champs manquants depuis Promotions
  if (enriched.promotionId == null) enriched.promotionId = promo.id;

  // Enrichir reduction si manquant OU si = 0 (ancien format stockait 0)
  if (enriched.reduction == null || enriched.reduction === 0) {
    const redRaw = doc.reduction ?? doc.percentOff ?? doc.discountPercent ?? doc.reductionPercent ?? doc.percent ?? doc.pct;
    const red = typeof redRaw === 'number' ? redRaw : typeof redRaw === 'string' ? Number(redRaw) : NaN;
    if (Number.isFinite(red) && red > 0 && red <= 100) {
      enriched.reduction = red;
      enriched.discountType = 'percent';
    }
  }

  if (enriched.expirationDate == null) {
    enriched.expirationDate = toDateOrNull(doc.expirationDate ?? doc.expiresAt ?? doc.expiryDate);
  }

  if (enriched.durationCycles == null) {
    const durRaw = doc.promo_duration ?? doc.promoDuration ?? doc.durationCycles ?? doc.duration;
    const dur = typeof durRaw === 'number' ? durRaw : typeof durRaw === 'string' ? Number(durRaw) : NaN;
    if (Number.isFinite(dur) && dur > 0) enriched.durationCycles = Math.floor(dur);
  }

  if (enriched.source == null) {
    enriched.source = pickString(doc.source) || enriched.code;
  }

  // Calculer discountInCents si on a la réduction et le prix de base
  if ((enriched.discountInCents == null || enriched.discountInCents === 0) && enriched.reduction != null && enriched.reduction > 0 && enriched.basePriceInCents != null) {
    if (enriched.discountType === 'percent') {
      enriched.discountInCents = Math.round((enriched.basePriceInCents * enriched.reduction) / 100);
    }
  }

  // Recalculer chargedPriceInCents si on a le basePriceInCents et discountInCents
  if (enriched.basePriceInCents != null && enriched.discountInCents != null && enriched.discountInCents > 0) {
    enriched.chargedPriceInCents = Math.max(0, enriched.basePriceInCents - enriched.discountInCents);
  }

  // Calculer revertAt si durationCycles > 0 et revertAt manquant
  if (enriched.revertAt == null && enriched.durationCycles != null && enriched.durationCycles > 0) {
    const startDate = toDateOrNull(sub.dates?.startDate) || toDateOrNull(sub.createdAt) || toDateOrNull(sub.payment?.lastPaymentDate);
    if (startDate) {
      enriched.revertAt = addMonths(startDate, enriched.durationCycles);
    }
  }

  return { enriched, promoFoundInDb: true };
}

function addMonths(date: Date, months: number): Date {
  const d = new Date(date);
  const day = d.getDate();
  d.setMonth(d.getMonth() + months);
  if (d.getDate() < day) d.setDate(0);
  return d;
}

// ---------------------------------------------------------------------------
// Construction du patch Firestore
// ---------------------------------------------------------------------------

function buildMigrationPatch(
  detected: DetectedPromo,
  sub: Record<string, any>
): Record<string, any> {
  const membership = pickString(sub.plan?.membership);
  const planType = pickString(sub.plan?.type);
  const planNormalized = planType === 'annual' ? 'annual' : 'monthly';

  const patch: Record<string, any> = {};

  // 1) promoCode top-level (format objet standard)
  patch.promoCode = {
    code: detected.code,
    reduction: detected.reduction ?? 0,
    appliedDate: detected.appliedDate || new Date().toISOString(),
    expirationDate: detected.expirationDate ? detected.expirationDate.toISOString() : null,
    source: detected.source || detected.code
  };

  // 2) pricing (format standard)
  const basePriceInCents = detected.basePriceInCents || Number(sub.plan?.price) || 0;
  const discountInCents = detected.discountInCents || 0;
  const chargedPriceInCents = detected.chargedPriceInCents || Number(sub.plan?.price) || 0;

  patch.pricing = {
    basePriceInCents,
    discountInCents,
    chargedPriceInCents,
    pricingSource: 'promo_applied',
    membershipTypeNormalized: membership,
    planNormalized,
    promo: {
      promoCode: detected.code,
      promotionId: detected.promotionId || '',
      discountType: detected.discountType || 'percent',
      discountValue: detected.reduction ?? 0,
      expiresAt: detected.expirationDate || null,
      durationCycles: detected.durationCycles || null,
      appliedAt: detected.appliedDate ? new Date(detected.appliedDate) : admin.firestore.FieldValue.serverTimestamp(),
      revertAt: detected.revertAt || null,
      // Préserver revertedAt si déjà fait
      ...(detected.revertedAt ? { revertedAt: detected.revertedAt } : {})
    }
  };

  patch.updatedAt = admin.firestore.FieldValue.serverTimestamp();

  return patch;
}

// ---------------------------------------------------------------------------
// Traitement d'un client
// ---------------------------------------------------------------------------

async function processClient(
  db: FirebaseFirestore.Firestore,
  uid: string,
  commit: boolean
): Promise<MigrationResult> {
  try {
    const clientRef = db.collection('Clients').doc(uid);
    const subRef = clientRef.collection('subscription').doc('current');
    const [subSnap, clientSnap] = await Promise.all([subRef.get(), clientRef.get()]);

    if (!subSnap.exists) {
      return { uid, action: 'skip_no_promo', detectedFormat: 'no_sub_doc', detected: null, detail: 'Pas de subscription/current' };
    }

    const sub = (subSnap.data() || {}) as Record<string, any>;
    const clientDoc = clientSnap.exists ? (clientSnap.data() || {}) as Record<string, any> : null;

    const { format, promo } = detectPromoFromSubscription(sub, clientDoc);

    if (format === 'no_promo') {
      return { uid, action: 'skip_no_promo', detectedFormat: format, detected: null, detail: 'Aucun code promo détecté' };
    }

    if (format === 'new_standard') {
      return { uid, action: 'skip_already_migrated', detectedFormat: format, detected: null, detail: 'Déjà au format standard' };
    }

    if (!promo || !promo.code) {
      return { uid, action: 'skip_no_promo', detectedFormat: format, detected: null, detail: 'Code promo vide' };
    }

    // Si déjà revert (revertedAt existe), on peut quand même migrer le format mais on note
    const isReverted = !!promo.revertedAt;

    // Enrichir depuis Promotions
    const { enriched, promoFoundInDb } = await enrichFromPromotions(db, promo, sub);

    // Si le code n'existe pas dans Promotions, c'est probablement un faux positif (texte parasite)
    if (!promoFoundInDb) {
      return { uid, action: 'skip_no_promo', detectedFormat: format, detected: enriched, detail: `Code "${enriched.code}" introuvable dans Promotions → skip` };
    }

    const patch = buildMigrationPatch(enriched, sub);

    if (commit) {
      await subRef.set(patch, { merge: true });
    }

    return {
      uid,
      action: isReverted ? 'skip_reverted' : 'migrate',
      detectedFormat: format,
      detected: enriched,
      detail: commit
        ? (isReverted ? `Migré (déjà revert) : ${enriched.code}` : `Migré : ${enriched.code}`)
        : (isReverted ? `[DRY-RUN] À migrer (déjà revert) : ${enriched.code}` : `[DRY-RUN] À migrer : ${enriched.code}`)
    };
  } catch (e: any) {
    return { uid, action: 'error', detectedFormat: 'error', detected: null, detail: String(e?.message || e) };
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Args {
  uid: string | null;
  all: boolean;
  commit: boolean;
  limit: number | null;
  concurrency: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { uid: null, all: false, commit: false, limit: null, concurrency: 5 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--uid') args.uid = String(argv[++i] || '').trim() || null;
    else if (a === '--all') args.all = true;
    else if (a === '--commit') args.commit = true;
    else if (a === '--limit') {
      const n = Number(String(argv[++i] || '').trim());
      args.limit = Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
    } else if (a === '--concurrency') {
      const n = Number(String(argv[++i] || '').trim());
      args.concurrency = Number.isFinite(n) && n >= 1 && n <= 20 ? Math.floor(n) : 5;
    } else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    }
  }
  return args;
}

function printHelp(): void {
  console.log(`
migrate-promo-format.ts — Normalise le format promo dans subscription/current

Usage:
  npx tsx scripts/migrate-promo-format.ts [options]

Options:
  --uid <UID>         Traiter un seul client
  --all               Traiter tous les clients
  --limit <N>         Limiter à N clients (par défaut: pas de limite)
  --commit            Appliquer les modifications (sans = dry-run)
  --concurrency <N>   Parallélisme (défaut: 5, max: 20)
  --help              Aide

Exemples:
  npx tsx scripts/migrate-promo-format.ts --uid ABC123
  npx tsx scripts/migrate-promo-format.ts --all --limit 5
  npx tsx scripts/migrate-promo-format.ts --all --limit 10 --commit
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.uid && !args.all) {
    console.error('❌ Argument manquant: utilisez --uid <UID> ou --all');
    printHelp();
    process.exit(1);
  }

  initializeFirebase();
  const db = getFirestore();

  console.log('━'.repeat(70));
  console.log(args.commit ? '🔴 MODE COMMIT (modifications appliquées)' : '🟡 MODE DRY-RUN (aucune modification)');
  console.log('━'.repeat(70));

  const results: MigrationResult[] = [];

  if (args.uid) {
    // Un seul client
    const result = await processClient(db, args.uid, args.commit);
    results.push(result);
  } else {
    // Tous les clients
    let query: FirebaseFirestore.Query = db.collection('Clients');
    if (args.limit) query = query.limit(args.limit);

    const snap = await query.get();
    console.log(`📊 ${snap.size} client(s) à traiter\n`);

    // Traitement par batch (concurrency)
    const uids = snap.docs.map((d) => d.id);
    for (let i = 0; i < uids.length; i += args.concurrency) {
      const batch = uids.slice(i, i + args.concurrency);
      const batchResults = await Promise.all(batch.map((uid) => processClient(db, uid, args.commit)));
      results.push(...batchResults);

      // Progress
      const done = Math.min(i + args.concurrency, uids.length);
      process.stdout.write(`\r  Progression: ${done}/${uids.length}`);
    }
    console.log('');
  }

  // ------ Rapport ------
  console.log('\n' + '━'.repeat(70));
  console.log('📋 RAPPORT DE MIGRATION');
  console.log('━'.repeat(70));

  const stats: Record<MigrationAction, number> = {
    skip_no_promo: 0,
    skip_already_migrated: 0,
    skip_reverted: 0,
    migrate: 0,
    error: 0
  };

  const formatStats: Record<string, number> = {};

  for (const r of results) {
    stats[r.action]++;
    formatStats[r.detectedFormat] = (formatStats[r.detectedFormat] || 0) + 1;

    // Afficher les détails intéressants
    if (r.action === 'migrate' || r.action === 'skip_reverted' || r.action === 'error') {
      const icon = r.action === 'error' ? '❌' : r.action === 'skip_reverted' ? '⏭️ ' : '✅';
      console.log(`${icon} [${r.uid}] ${r.detail}`);
      if (r.detected) {
        console.log(`   Format: ${r.detectedFormat} | Code: ${r.detected.code} | Réduction: ${r.detected.reduction ?? '?'}%`);
        console.log(`   Base: ${r.detected.basePriceInCents ?? '?'} cts | Final: ${r.detected.chargedPriceInCents ?? '?'} cts | Remise: ${r.detected.discountInCents ?? '?'} cts`);
        if (r.detected.durationCycles) console.log(`   Durée promo: ${r.detected.durationCycles} mois | revertAt: ${r.detected.revertAt?.toISOString() || 'null'}`);
        if (r.detected.revertedAt) console.log(`   ⚠️  Déjà revert`);
      }
    }
  }

  console.log('\n📊 Statistiques:');
  console.log(`   Total clients analysés:    ${results.length}`);
  console.log(`   Sans promo (skip):         ${stats.skip_no_promo}`);
  console.log(`   Déjà au format (skip):     ${stats.skip_already_migrated}`);
  console.log(`   Déjà revert (skip):        ${stats.skip_reverted}`);
  console.log(`   À migrer / migrés:         ${stats.migrate}`);
  console.log(`   Erreurs:                   ${stats.error}`);

  console.log('\n📊 Formats détectés:');
  for (const [fmt, count] of Object.entries(formatStats).sort((a, b) => b[1] - a[1])) {
    console.log(`   ${fmt}: ${count}`);
  }

  if (!args.commit && stats.migrate > 0) {
    console.log(`\n💡 Pour appliquer: ajoutez --commit`);
  }

  console.log('━'.repeat(70));
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
