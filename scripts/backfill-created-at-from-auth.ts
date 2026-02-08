import { initializeFirebase, getAuth, getFirestore, admin } from '../src/config/firebase.js';

type Args = {
  uid: string | null;
  all: boolean;
  commit: boolean;
  limit: number | null;
  concurrency: number;
  force: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    uid: null,
    all: false,
    commit: false,
    limit: null,
    concurrency: 10,
    force: false
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--uid') args.uid = String(argv[++i] || '').trim() || null;
    else if (a === '--all') args.all = true;
    else if (a === '--commit') args.commit = true;
    else if (a === '--force') args.force = true;
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
Backfill "Created At" (Clients) depuis Firebase Auth.

Usage:
  tsx scripts/backfill-created-at-from-auth.ts --uid <UID> [--commit] [--force]
  tsx scripts/backfill-created-at-from-auth.ts --all [--limit N] [--concurrency N] [--commit] [--force]

Flags:
  --uid <UID>        Traiter un seul client (doc Clients/<UID>)
  --all              Traiter tous les documents de la collection Clients
  --commit           Écrit dans Firestore (sinon DRY-RUN)
  --force            Écrase un éventuel "Created At" existant (par défaut: on ne touche pas si déjà présent)
  --limit N          Limite le nombre de clients traités en mode --all
  --concurrency N    Concurrence (1..50), défaut 10
`);
  process.exit(code);
}

function parseAuthCreationTime(user: admin.auth.UserRecord): Date | null {
  const raw = user?.metadata?.creationTime;
  if (!raw || typeof raw !== 'string') return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d;
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

async function upsertCreatedAtForUid(params: {
  uid: string;
  commit: boolean;
  force: boolean;
}): Promise<
  | { ok: true; uid: string; action: 'skipped_already_present' | 'updated' | 'dry_run_update'; createdAt: Date }
  | { ok: false; uid: string; reason: 'client_not_found' | 'auth_user_not_found' | 'auth_no_creation_time' | 'unknown'; message?: string }
> {
  const { uid, commit, force } = params;
  const db = getFirestore();
  const auth = getAuth();

  const clientRef = db.collection('Clients').doc(uid);
  const clientSnap = await clientRef.get();
  if (!clientSnap.exists) {
    return { ok: false, uid, reason: 'client_not_found' };
  }

  const existing = (clientSnap.data() || {}) as Record<string, any>;
  const hasCreatedAt = existing?.['Created At'] != null;
  if (hasCreatedAt && !force) {
    // On ne modifie pas ce champ s'il est déjà présent (sécurité)
    const existingDate =
      typeof existing?.['Created At']?.toDate === 'function'
        ? (existing['Created At'] as any).toDate()
        : new Date();
    return { ok: true, uid, action: 'skipped_already_present', createdAt: existingDate };
  }

  let user: admin.auth.UserRecord;
  try {
    user = await auth.getUser(uid);
  } catch (e: any) {
    if (String(e?.code || '') === 'auth/user-not-found') {
      return { ok: false, uid, reason: 'auth_user_not_found' };
    }
    return { ok: false, uid, reason: 'unknown', message: String(e?.message || e) };
  }

  const createdAt = parseAuthCreationTime(user);
  if (!createdAt) {
    return { ok: false, uid, reason: 'auth_no_creation_time' };
  }

  const ts = admin.firestore.Timestamp.fromDate(createdAt);
  if (!commit) {
    return { ok: true, uid, action: 'dry_run_update', createdAt };
  }

  await clientRef.set({ 'Created At': ts }, { merge: true });
  return { ok: true, uid, action: 'updated', createdAt };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  console.log('🔧 Backfill Clients."Created At" depuis Firebase Auth');
  console.log('   Mode:', args.uid ? `UID=${args.uid}` : '--all');
  console.log('   Write:', args.commit ? 'OUI (--commit)' : 'NON (DRY-RUN)');
  console.log('   Force overwrite:', args.force ? 'OUI (--force)' : 'NON');
  if (args.all) {
    console.log('   Concurrency:', args.concurrency);
    if (args.limit) console.log('   Limit:', args.limit);
  }
  console.log('─'.repeat(80));

  initializeFirebase();
  const db = getFirestore();

  if (args.uid) {
    const r = await upsertCreatedAtForUid({ uid: args.uid, commit: args.commit, force: args.force });
    console.log(r);
    return;
  }

  // Mode --all : on lit uniquement le champ "Created At" pour minimiser le payload
  const snap = await db.collection('Clients').select('Created At').get();
  const ids = snap.docs.map((d) => d.id);
  const limitedIds = args.limit ? ids.slice(0, args.limit) : ids;

  console.log(`📦 Clients à analyser: ${limitedIds.length} (sur ${ids.length} docs)`);

  let updated = 0;
  let dryRunUpdates = 0;
  let skipped = 0;
  let authMissing = 0;
  let clientMissing = 0;
  let authNoCreationTime = 0;
  let unknown = 0;

  const t0 = Date.now();

  await asyncPool(limitedIds, args.concurrency, async (uid, idx) => {
    if ((idx + 1) % 250 === 0) {
      console.log(`   Progression: ${idx + 1}/${limitedIds.length}`);
    }
    const r = await upsertCreatedAtForUid({ uid, commit: args.commit, force: args.force });
    if (r.ok) {
      if (r.action === 'updated') updated++;
      else if (r.action === 'dry_run_update') dryRunUpdates++;
      else skipped++;
      return;
    }
    if (r.reason === 'auth_user_not_found') authMissing++;
    else if (r.reason === 'client_not_found') clientMissing++;
    else if (r.reason === 'auth_no_creation_time') authNoCreationTime++;
    else unknown++;
  });

  const dt = Date.now() - t0;
  console.log('─'.repeat(80));
  console.log('✅ Terminé');
  console.log('   Durée:', `${dt}ms`);
  console.log('   updated:', updated);
  console.log('   dry_run_update:', dryRunUpdates);
  console.log('   skipped_already_present:', skipped);
  console.log('   auth_user_not_found:', authMissing);
  console.log('   client_not_found:', clientMissing);
  console.log('   auth_no_creation_time:', authNoCreationTime);
  console.log('   unknown_errors:', unknown);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('❌ Erreur fatale:', e);
    process.exit(1);
  });

