import { initializeFirebase, getFirestore } from '../src/config/firebase.js';
import { computeAndWriteSeniorityForClient } from '../src/services/clientSeniority.service.js';

type Args = {
  uid: string | null;
  all: boolean;
  commit: boolean;
  limit: number | null;
  concurrency: number;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    uid: null,
    all: false,
    commit: false,
    limit: null,
    concurrency: 10
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
Backfill "seniority" (Clients) depuis le champ "Created At".

Usage:
  tsx scripts/backfill-seniority.ts --uid <UID> [--commit]
  tsx scripts/backfill-seniority.ts --all [--limit N] [--concurrency N] [--commit]

Flags:
  --uid <UID>        Traiter un seul client (doc Clients/<UID>)
  --all              Traiter tous les documents de la collection Clients
  --commit           Écrit dans Firestore (sinon DRY-RUN)
  --limit N          Limite le nombre de clients traités en mode --all
  --concurrency N    Concurrence (1..50), défaut 10
`);
  process.exit(code);
}

async function asyncPool<T, R>(items: T[], concurrency: number, fn: (item: T, idx: number) => Promise<R>): Promise<R[]> {
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  console.log('🔧 Backfill Clients.seniority depuis "Created At"');
  console.log('   Mode:', args.uid ? `UID=${args.uid}` : '--all');
  console.log('   Write:', args.commit ? 'OUI (--commit)' : 'NON (DRY-RUN)');
  if (args.all) {
    console.log('   Concurrency:', args.concurrency);
    if (args.limit) console.log('   Limit:', args.limit);
  }
  console.log('─'.repeat(80));

  initializeFirebase();
  const db = getFirestore();

  if (args.uid) {
    const r = await computeAndWriteSeniorityForClient({
      clientId: args.uid,
      commit: args.commit
    });
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  // Mode --all : on lit uniquement les IDs pour minimiser le payload
  const snap = await db.collection('Clients').select('Created At', 'createdAt').get();
  const ids = snap.docs.map((d) => d.id);
  const limitedIds = args.limit ? ids.slice(0, args.limit) : ids;

  console.log(`📦 Clients à analyser: ${limitedIds.length} (sur ${ids.length} docs)`);

  let updated = 0;
  let dryRun = 0;
  let noCreatedAt = 0;
  let clientNotFound = 0;
  let otherErrors = 0;

  const t0 = Date.now();

  await asyncPool(limitedIds, args.concurrency, async (uid, idx) => {
    if ((idx + 1) % 250 === 0) {
      console.log(`   Progression: ${idx + 1}/${limitedIds.length}`);
    }
    const r = await computeAndWriteSeniorityForClient({
      clientId: uid,
      commit: args.commit
    });
    if (r.ok) {
      if (r.action === 'updated') updated++;
      else dryRun++;
      return;
    }
    if (r.reason === 'no_created_at') noCreatedAt++;
    else if (r.reason === 'client_not_found') clientNotFound++;
    else otherErrors++;
  });

  const dt = Date.now() - t0;
  console.log('─'.repeat(80));
  console.log('✅ Terminé');
  console.log('   Durée:', `${dt}ms`);
  console.log('   updated:', updated);
  console.log('   dry_run:', dryRun);
  console.log('   no_created_at (skipped):', noCreatedAt);
  console.log('   client_not_found:', clientNotFound);
  console.log('   other_errors:', otherErrors);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('❌ Erreur fatale:', e);
    process.exit(1);
  });
