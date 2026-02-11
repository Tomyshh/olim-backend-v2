/**
 * backfill-subscription-current.ts
 * ─────────────────────────────────
 * Crée le document `Clients/{uid}/subscription/current` pour les clients
 * qui n'en possèdent pas encore (anciens abonnés, architecture pré-migration).
 *
 * Le document est créé au format canonique actuel, en mode "Visitor" vierge
 * (prêt à être mis à jour manuellement ou via le système).
 *
 * ⚠️  DRY-RUN par défaut — utiliser --commit pour écrire réellement.
 *
 * Usage:
 *   tsx scripts/backfill-subscription-current.ts --uid <UID> [--commit]
 *   tsx scripts/backfill-subscription-current.ts --all [--limit N] [--concurrency N] [--commit]
 */

import { initializeFirebase, getFirestore, admin } from '../src/config/firebase.js';

// ─── Types ────────────────────────────────────────────────────────────────────

type Args = {
  uid: string | null;
  all: boolean;
  commit: boolean;
  limit: number | null;
  concurrency: number;
};

// ─── Parse CLI args ───────────────────────────────────────────────────────────

function parseArgs(argv: string[]): Args {
  const args: Args = {
    uid: null,
    all: false,
    commit: false,
    limit: null,
    concurrency: 10,
  };

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
      args.concurrency = Number.isFinite(n) && n >= 1 && n <= 50 ? Math.floor(n) : 10;
    } else if (a === '--help' || a === '-h') {
      printHelpAndExit(0);
    }
  }

  if (!args.uid && !args.all) {
    console.error('❌ Argument manquant: utilisez --uid <UID> ou --all');
    printHelpAndExit(1);
  }
  if (args.uid && args.all) {
    console.error('❌ Arguments incompatibles: choisissez soit --uid, soit --all');
    printHelpAndExit(1);
  }
  return args;
}

function printHelpAndExit(code: number): never {
  console.log(`
Backfill "subscription/current" pour les clients qui n'en ont pas.

Crée un document vierge au format canonique (Visitor, prix 0, inactif)
prêt à être mis à jour par le système ou manuellement.

Usage:
  tsx scripts/backfill-subscription-current.ts --uid <UID> [--commit]
  tsx scripts/backfill-subscription-current.ts --all [--limit N] [--concurrency N] [--commit]

Flags:
  --uid <UID>        Traiter un seul client (doc Clients/<UID>)
  --all              Traiter tous les documents de la collection Clients
  --commit           Écrit dans Firestore (sinon DRY-RUN)
  --limit N          Limite le nombre de clients traités en mode --all
  --concurrency N    Concurrence (1..50), défaut 10
`);
  process.exit(code);
}

// ─── Async pool helper ────────────────────────────────────────────────────────

async function asyncPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, idx: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const idx = nextIndex++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx] as T, idx);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ─── Build blank subscription/current ─────────────────────────────────────────

/**
 * Génère le document `subscription/current` vierge au format canonique.
 *
 * Champs alignés sur `buildSubscriptionCurrentDoc` (subscription.controller.ts
 * + clientSubscription.controller.ts). Valeurs neutres :
 *  - membership = "Visitor", price = 0, isActive = false
 *  - Aucune donnée PayMe
 *  - dates toutes à null (pas de startDate/endDate inventée)
 *  - modifiedBy = "MIGRATION_BACKFILL_SUBSCRIPTION"
 */
function buildBlankSubscriptionCurrent(): Record<string, any> {
  const now = new Date();

  return {
    // Flag canonique d'impayé (mobile)
    isUnpaid: false,

    // 1. plan
    plan: {
      type: 'monthly',
      membership: 'Visitor',
      price: 0,
      currency: 'ILS',
      basePriceInCents: 0,
    },

    // 2. payment
    payment: {
      method: 'none',
      installments: 1,
      nextPaymentDate: null,
      lastPaymentDate: null,
    },

    // 3. payme
    payme: {
      subCode: null,
      subID: null,
      buyerKey: null,
      status: null,
    },

    // 4. dates
    dates: {
      startDate: null,
      endDate: null,
      pausedDate: null,
      cancelledDate: null,
      resumedDate: null,
    },

    // 5. states
    states: {
      isActive: false,
      isPaused: false,
      willExpire: false,
      isAnnual: false,
    },

    // 6. history
    history: {
      previousMembership: null,
      previousPlan: null,
      lastModified: now,
      modifiedBy: 'MIGRATION_BACKFILL_SUBSCRIPTION',
    },

    // 7. timestamps
    createdAt: now,
    updatedAt: now,
  };
}

// ─── Process single client ────────────────────────────────────────────────────

type ProcessResult = {
  uid: string;
  action: 'created' | 'skipped_exists' | 'skipped_no_client' | 'dry_run' | 'error';
  reason?: string;
};

async function processClient(
  db: FirebaseFirestore.Firestore,
  uid: string,
  commit: boolean,
): Promise<ProcessResult> {
  try {
    // 1. Vérifier que le client existe
    const clientRef = db.collection('Clients').doc(uid);
    const clientSnap = await clientRef.get();
    if (!clientSnap.exists) {
      return { uid, action: 'skipped_no_client', reason: 'Document Clients/{uid} introuvable' };
    }

    // 2. Vérifier si subscription/current existe déjà
    const subRef = clientRef.collection('subscription').doc('current');
    const subSnap = await subRef.get();
    if (subSnap.exists) {
      return { uid, action: 'skipped_exists', reason: 'subscription/current existe déjà' };
    }

    // 3. Créer le document vierge
    const doc = buildBlankSubscriptionCurrent();

    if (!commit) {
      return { uid, action: 'dry_run', reason: 'DRY-RUN — document prêt à créer' };
    }

    await subRef.set(doc);
    return { uid, action: 'created' };
  } catch (err: any) {
    return { uid, action: 'error', reason: err?.message || String(err) };
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  console.log('🔧 Backfill subscription/current (format canonique vierge)');
  console.log('   Mode:', args.uid ? `UID=${args.uid}` : '--all');
  console.log('   Write:', args.commit ? 'OUI (--commit)' : 'NON (DRY-RUN)');
  if (args.all) {
    console.log('   Concurrency:', args.concurrency);
    if (args.limit) console.log('   Limit:', args.limit);
  }
  console.log('─'.repeat(80));

  initializeFirebase();
  const db = getFirestore();

  // ── Mode single UID ──────────────────────────────────────────────────────
  if (args.uid) {
    const result = await processClient(db, args.uid, args.commit);
    console.log(JSON.stringify(result, null, 2));

    if (result.action === 'dry_run') {
      console.log('\n📋 Document qui serait créé :');
      console.log(JSON.stringify(buildBlankSubscriptionCurrent(), null, 2));
    }
    return;
  }

  // ── Mode --all : pagination par documentId ───────────────────────────────
  const pageSize = 250;
  const docIdField = admin.firestore.FieldPath.documentId();
  let lastDoc: FirebaseFirestore.QueryDocumentSnapshot | null = null;
  const allIds: string[] = [];

  console.log('📦 Chargement des IDs clients...');

  while (true) {
    let q: FirebaseFirestore.Query = db
      .collection('Clients')
      .orderBy(docIdField)
      .limit(pageSize);

    if (lastDoc) q = q.startAfter(lastDoc);

    const snap = await q.select().get(); // select() = IDs seulement
    if (snap.empty) break;

    for (const doc of snap.docs) {
      allIds.push(doc.id);
    }

    lastDoc = snap.docs[snap.docs.length - 1]!;
    if (snap.docs.length < pageSize) break;
  }

  const limitedIds = args.limit ? allIds.slice(0, args.limit) : allIds;
  console.log(`📦 Clients à analyser: ${limitedIds.length} (sur ${allIds.length} docs)`);
  console.log('─'.repeat(80));

  // Compteurs
  let created = 0;
  let skippedExists = 0;
  let skippedNoClient = 0;
  let dryRun = 0;
  let errors = 0;

  const t0 = Date.now();

  await asyncPool(limitedIds, args.concurrency, async (uid, idx) => {
    if ((idx + 1) % 250 === 0 || idx + 1 === limitedIds.length) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`   Progression: ${idx + 1}/${limitedIds.length}  (${elapsed}s)`);
    }

    const result = await processClient(db, uid, args.commit);

    switch (result.action) {
      case 'created':
        created++;
        break;
      case 'skipped_exists':
        skippedExists++;
        break;
      case 'skipped_no_client':
        skippedNoClient++;
        break;
      case 'dry_run':
        dryRun++;
        break;
      case 'error':
        errors++;
        console.error(`   ⚠️  Erreur UID=${uid}: ${result.reason}`);
        break;
    }
  });

  const dt = Date.now() - t0;
  console.log('─'.repeat(80));
  console.log('✅ Terminé');
  console.log('   Durée:', `${dt}ms`);
  console.log('   created:', created);
  console.log('   skipped_exists (déjà ok):', skippedExists);
  console.log('   skipped_no_client:', skippedNoClient);
  if (!args.commit) console.log('   dry_run (à créer):', dryRun);
  console.log('   errors:', errors);

  if (!args.commit && dryRun > 0) {
    console.log('\n💡 Pour appliquer les changements, relancez avec --commit');
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('❌ Erreur fatale:', e);
    process.exit(1);
  });
