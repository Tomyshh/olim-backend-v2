import { config } from 'dotenv';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { initializeFirebase, getFirestore, admin } from '../src/config/firebase.js';
import {
  paymeGetSubscriptionStatus,
  paymeListSubscriptions,
  type PaymeSubscriptionListItem
} from '../src/services/payme.service.js';

function loadEnv(): void {
  // Priorité: .env.local (dev), puis .env, puis DOTENV_CONFIG_PATH si fourni.
  const explicit = (process.env.DOTENV_CONFIG_PATH || '').trim();
  const candidates = [
    ...(explicit ? [explicit] : []),
    '.env.local',
    '.env'
  ];
  for (const rel of candidates) {
    const abs = resolve(process.cwd(), rel);
    if (!existsSync(abs)) continue;
    config({ path: abs });
    // On charge le premier qui existe (comportement simple et prévisible)
    return;
  }
  // Fallback: dotenv default (ne fera rien si aucun fichier)
  config();
}

loadEnv();

type Args = {
  apply: boolean;
  all: boolean;
  clientId: string;
  limit: number; // only used with --all (0 = unlimited)
  reportPath: string;
};

function pickArg(name: string): string {
  const idx = process.argv.findIndex((x) => x === `--${name}`);
  if (idx >= 0) return String(process.argv[idx + 1] || '').trim();
  return '';
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    apply: false,
    all: false,
    clientId: 'KDoSoj5XrXOMwa828dcbuRpRd923',
    limit: 0,
    reportPath: ''
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') args.apply = true;
    if (a === '--all') args.all = true;
    if (a === '--clientId') args.clientId = String(argv[i + 1] || '').trim();
    if (a === '--report') args.reportPath = String(argv[i + 1] || '').trim();
    if (a === '--limit') {
      const n = Number(String(argv[i + 1] || '').trim());
      args.limit = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
    }
  }
  return args;
}

function pickString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeEmail(email: string): string {
  return pickString(email).toLowerCase();
}

function coerceSubCodeToComparable(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string' && value.trim()) return value.trim();
  return '';
}

function chooseMostRecentActive(items: PaymeSubscriptionListItem[]): PaymeSubscriptionListItem | null {
  const active = items.filter((x) => x && x.subStatus === 2 && x.subCode != null && x.description);
  if (active.length === 0) return null;

  function parseCreatedMs(it: PaymeSubscriptionListItem): number {
    const raw = it?.raw?.sub_created ?? it?.raw?.created_at ?? it?.raw?.createdAt ?? null;
    if (raw == null) return 0;
    if (raw instanceof Date && Number.isFinite(raw.getTime())) return raw.getTime();
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      // Heuristique: si < 1e12 => probablement seconds
      return raw < 1e12 ? raw * 1000 : raw;
    }
    if (typeof raw === 'string' && raw.trim()) {
      const s = raw.trim();
      const n = Number(s);
      if (Number.isFinite(n)) return n < 1e12 ? n * 1000 : n;
      const d = new Date(s);
      return Number.isFinite(d.getTime()) ? d.getTime() : 0;
    }
    return 0;
  }

  function scoreDateMs(it: PaymeSubscriptionListItem): number {
    const created = parseCreatedMs(it);
    if (created > 0) return created;
    const d = it.nextPaymentDate || it.startDate || null;
    return d instanceof Date && Number.isFinite(d.getTime()) ? d.getTime() : 0;
  }

  function scoreSubCode(it: PaymeSubscriptionListItem): number {
    const v = it.subCode;
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
    return Number.isFinite(n) ? n : 0;
  }

  // Tri: date desc, puis subCode desc
  return [...active].sort((a, b) => {
    const da = scoreDateMs(a);
    const db = scoreDateMs(b);
    if (db !== da) return db - da;
    return scoreSubCode(b) - scoreSubCode(a);
  })[0]!;
}

async function loadClient(params: { clientId: string }): Promise<{
  clientRef: FirebaseFirestore.DocumentReference;
  client: Record<string, any>;
  subscriptionRef: FirebaseFirestore.DocumentReference;
  subscription: Record<string, any> | null;
}> {
  const db = getFirestore();
  const clientRef = db.collection('Clients').doc(params.clientId);
  const [clientSnap, subSnap] = await Promise.all([
    clientRef.get(),
    clientRef.collection('subscription').doc('current').get()
  ]);
  if (!clientSnap.exists) {
    throw new Error(`Client introuvable: ${params.clientId}`);
  }
  return {
    clientRef,
    client: (clientSnap.data() || {}) as any,
    subscriptionRef: clientRef.collection('subscription').doc('current'),
    subscription: subSnap.exists ? ((subSnap.data() || {}) as any) : null
  };
}

function extractFirestoreCurrent(params: { client: Record<string, any>; subscription: Record<string, any> | null }): {
  membershipOnClientDoc: string;
  membershipOnSubscriptionDoc: string;
  paymeSubCodeOnSubscriptionDoc: string;
  paymeStatusOnSubscriptionDoc: string;
} {
  const membershipOnClientDoc = pickString(params.client?.Membership);
  const membershipOnSubscriptionDoc =
    pickString(params.subscription?.plan?.membership) ||
    pickString(params.subscription?.plan?.Membership) ||
    pickString(params.subscription?.membership) ||
    '';

  const paymeSubCodeOnSubscriptionDoc =
    coerceSubCodeToComparable(params.subscription?.payme?.subCode) ||
    coerceSubCodeToComparable(params.subscription?.subCode) ||
    coerceSubCodeToComparable(params.subscription?.sub_payme_code) ||
    '';

  const paymeStatusOnSubscriptionDoc =
    coerceSubCodeToComparable(params.subscription?.payme?.status) ||
    coerceSubCodeToComparable((params.subscription as any)?.payme?.sub_status) ||
    coerceSubCodeToComparable((params.subscription as any)?.payme?.subStatus) ||
    coerceSubCodeToComparable((params.subscription as any)?.payme?.sub_status) ||
    '';

  return { membershipOnClientDoc, membershipOnSubscriptionDoc, paymeSubCodeOnSubscriptionDoc, paymeStatusOnSubscriptionDoc };
}

async function syncOneClient(params: {
  clientId: string;
  byEmail: Map<string, PaymeSubscriptionListItem[]>;
  apply: boolean;
}): Promise<{
  changed: boolean;
  reason: string;
  change?: {
    clientId: string;
    email: string;
    before: {
      membershipOnClientDoc: string;
      membershipOnSubscriptionDoc: string;
      paymeSubCodeOnSubscriptionDoc: string;
      paymeStatusOnSubscriptionDoc: string;
    };
    after: {
      membership: string;
      subCode: string;
      status: string;
    };
  };
}> {
  const { clientRef, client, subscriptionRef, subscription } = await loadClient({ clientId: params.clientId });

  const email = normalizeEmail(pickString(client?.Email));
  if (!email) return { changed: false, reason: 'skip:no_email' };

  const items = params.byEmail.get(email) || [];
  const best = chooseMostRecentActive(items);
  if (!best) {
    const dist: Record<string, number> = {};
    for (const it of items) {
      const k = it?.subStatus == null ? 'null' : String(it.subStatus);
      dist[k] = (dist[k] || 0) + 1;
    }
    console.log('[INFO] No active subscription for client', {
      clientId: params.clientId,
      email,
      paymeItemsForEmail: items.length,
      subStatusDistribution: dist
    });
    return { changed: false, reason: 'skip:no_active_subscription' };
  }

  const desiredMembership = pickString(best.description);
  const desiredSubCode = best.subCode != null ? String(best.subCode) : '';
  const desiredStatus = best.subStatus != null ? String(best.subStatus) : '';
  if (!desiredMembership || !desiredSubCode) return { changed: false, reason: 'skip:invalid_payme_data' };

  const current = extractFirestoreCurrent({ client, subscription });
  const ok =
    current.membershipOnClientDoc === desiredMembership &&
    current.membershipOnSubscriptionDoc === desiredMembership &&
    current.paymeSubCodeOnSubscriptionDoc === desiredSubCode &&
    // Si PayMe fournit un status (2 actif / 5 annulé), on le synchronise aussi.
    (!desiredStatus || current.paymeStatusOnSubscriptionDoc === desiredStatus);

  if (ok) return { changed: false, reason: 'ok:already_synced' };

  const change = {
    clientId: params.clientId,
    email,
    before: current,
    after: { membership: desiredMembership, subCode: desiredSubCode, status: desiredStatus || '' }
  };

  const payloadClient = { Membership: desiredMembership };
  const payloadSub = {
    plan: { membership: desiredMembership },
    payme: {
      subCode: best.subCode,
      status: best.subStatus ?? null,
      // Nettoyage: l'ancien champ incorrect "subcode" ne doit plus exister.
      ...(params.apply ? { subcode: admin.firestore.FieldValue.delete() } : {})
    },
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  };

  if (!params.apply) {
    console.log('[DRY-RUN] Would update', {
      clientId: params.clientId,
      email,
      desired: { membership: desiredMembership, subCode: desiredSubCode },
      current
    });
    return { changed: false, reason: 'dry_run', change };
  }

  const db = getFirestore();
  const batch = db.batch();
  batch.set(clientRef, payloadClient, { merge: true });
  batch.set(subscriptionRef, payloadSub, { merge: true });
  await batch.commit();

  console.log('[APPLY] Updated', {
    clientId: params.clientId,
    email,
    desired: { membership: desiredMembership, subCode: desiredSubCode },
    before: current
  });
  return { changed: true, reason: 'updated', change };
}

function reportDefaultPath(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return resolve(process.cwd(), 'tmp', `payme-firestore-sync-${stamp}.md`);
}

function toMdReport(params: {
  startedAtIso: string;
  finishedAtIso: string;
  scanned: number;
  changed: number;
  alreadyOk: number;
  skippedNoEmail: number;
  skippedNoActive: number;
  errors: number;
  changes: Array<{
    clientId: string;
    email: string;
    before: {
      membershipOnClientDoc: string;
      membershipOnSubscriptionDoc: string;
      paymeSubCodeOnSubscriptionDoc: string;
      paymeStatusOnSubscriptionDoc: string;
    };
    after: { membership: string; subCode: string; status: string };
  }>;
}): string {
  const lines: string[] = [];
  lines.push('# Rapport sync PayMe → Firestore');
  lines.push('');
  lines.push(`- Début: ${params.startedAtIso}`);
  lines.push(`- Fin: ${params.finishedAtIso}`);
  lines.push(`- Clients scannés: ${params.scanned}`);
  lines.push(`- Clients modifiés: ${params.changed}`);
  lines.push(`- Déjà OK: ${params.alreadyOk}`);
  lines.push(`- Skip (no email): ${params.skippedNoEmail}`);
  lines.push(`- Skip (no active subscription): ${params.skippedNoActive}`);
  lines.push(`- Erreurs: ${params.errors}`);
  lines.push('');

  if (params.changes.length === 0) {
    lines.push('Aucun client modifié.');
    lines.push('');
    return lines.join('\n');
  }

  lines.push('## Détails des clients modifiés');
  lines.push('');

  for (const c of params.changes) {
    lines.push(`### ${c.clientId}`);
    lines.push('');
    lines.push(`- Email: ${c.email}`);
    lines.push('- Avant:');
    lines.push(`  - Membership (Clients/{id}): ${c.before.membershipOnClientDoc || '(vide)'}`);
    lines.push(`  - plan.membership (subscription/current): ${c.before.membershipOnSubscriptionDoc || '(vide)'}`);
    lines.push(`  - payme.subCode (subscription/current): ${c.before.paymeSubCodeOnSubscriptionDoc || '(vide)'}`);
    lines.push(`  - payme.status (subscription/current): ${c.before.paymeStatusOnSubscriptionDoc || '(vide)'}`);
    lines.push('- Après:');
    lines.push(`  - Membership (Clients/{id}): ${c.after.membership}`);
    lines.push(`  - plan.membership (subscription/current): ${c.after.membership}`);
    lines.push(`  - payme.subCode (subscription/current): ${c.after.subCode}`);
    lines.push(`  - payme.status (subscription/current): ${c.after.status || '(inchangé/indisponible)'}`);
    lines.push('');
  }

  return lines.join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = new Date();

  console.log('🔧 Script: sync PayMe -> Firestore (Membership + subscription/current)');
  console.log(`- mode: ${args.apply ? 'APPLY (écrit)' : 'DRY-RUN (aucun changement)'}`);
  console.log(`- cible: ${args.all ? `ALL Clients${args.limit ? ` (limit=${args.limit})` : ''}` : `clientId=${args.clientId}`}`);
  if (args.all && args.apply) {
    const out = args.reportPath ? resolve(process.cwd(), args.reportPath) : reportDefaultPath();
    console.log(`- rapport: ${out}`);
  }
  console.log('');

  initializeFirebase();

  console.log('⏳ Chargement des subscriptions PayMe (liste vendeur)…');
  const subs = await paymeListSubscriptions();
  console.log(`- PayMe items reçus: ${subs.length}`);
  if (subs.length === 0) {
    console.log('⚠️  Aucune subscription renvoyée par PayMe. Si ce compte a des abonnements, PayMe ne supporte peut-être pas le listing via get-subscriptions sans sub_payme_code.');
  }
  {
    const dist: Record<string, number> = {};
    for (const s of subs) {
      const k = s?.subStatus == null ? 'null' : String(s.subStatus);
      dist[k] = (dist[k] || 0) + 1;
    }
    console.log('- Distribution subStatus (PayMe):', dist);
  }

  if (process.env.PAYME_SYNC_DEBUG === 'true' && subs.length > 0) {
    // Debug: comparer le subStatus "list" vs le status renvoyé par get-subscriptions ciblé (subCode)
    const sample = subs.find((x) => x?.subCode != null) || subs[0]!;
    const subCode = sample?.subCode;
    try {
      const status = subCode != null ? await paymeGetSubscriptionStatus(subCode) : null;
      console.log('[DEBUG] PayMe status check', {
        subCode,
        listSubStatus: sample?.subStatus ?? null,
        getSubscriptionsSubStatus: status
      });
    } catch (e: any) {
      console.log('[DEBUG] PayMe status check failed', { subCode, error: e?.message || String(e) });
    }
  }

  const byEmail = new Map<string, PaymeSubscriptionListItem[]>();
  for (const s of subs) {
    const email = s?.email ? normalizeEmail(s.email) : '';
    if (!email) continue;
    const arr = byEmail.get(email) || [];
    arr.push(s);
    byEmail.set(email, arr);
  }
  console.log(`- Emails indexés: ${byEmail.size}`);
  if (subs.length > 0 && byEmail.size === 0) {
    const sample = subs[0]?.raw || null;
    console.log('⚠️  Debug: PayMe items sans email détectable. Exemple keys(item):', sample ? Object.keys(sample) : null);
    if (sample?.sub_buyer_details && typeof sample.sub_buyer_details === 'object') {
      console.log('⚠️  Debug: keys(sub_buyer_details):', Object.keys(sample.sub_buyer_details));
      console.log('⚠️  Debug: sub_buyer_details (extrait):', {
        email: sample.sub_buyer_details.email ?? null,
        buyer_email: sample.sub_buyer_details.buyer_email ?? null,
        mail: sample.sub_buyer_details.mail ?? null,
        buyerEmail: sample.sub_buyer_details.buyerEmail ?? null
      });
    }
    console.log('⚠️  Debug: Exemple mapping (extrait):', {
      subCode: subs[0]?.subCode ?? null,
      subStatus: subs[0]?.subStatus ?? null,
      email: subs[0]?.email ?? null,
      description: subs[0]?.description ?? null,
      nextPaymentDateYmd: subs[0]?.nextPaymentDateYmd ?? null,
      startDateYmd: subs[0]?.startDateYmd ?? null
    });
  }
  console.log('');

  if (!args.all) {
    const r = await syncOneClient({ clientId: args.clientId, byEmail, apply: args.apply });
    console.log('Résultat', { clientId: args.clientId, reason: r.reason, changed: r.changed });
    return;
  }

  // Mode ALL: parcourt la collection Clients en pages (orderBy docId)
  const db = getFirestore();
  const pageSize = 250;
  const docIdField = admin.firestore.FieldPath.documentId();
  let lastDoc: FirebaseFirestore.QueryDocumentSnapshot | null = null;
  let scanned = 0;
  let changed = 0;
  let skippedNoEmail = 0;
  let skippedNoActive = 0;
  let alreadyOk = 0;
  let errors = 0;
  const changes: Array<NonNullable<Awaited<ReturnType<typeof syncOneClient>>['change']>> = [];

  console.log('🚀 Démarrage scan Clients…');
  while (true) {
    let q: FirebaseFirestore.Query = db.collection('Clients').orderBy(docIdField).limit(pageSize);
    if (lastDoc) q = q.startAfter(lastDoc);
    const snap = await q.get();
    if (snap.empty) break;
    lastDoc = snap.docs[snap.docs.length - 1]!;

    for (const doc of snap.docs) {
      scanned++;
      if (args.limit > 0 && scanned > args.limit) break;
      try {
        const r = await syncOneClient({ clientId: doc.id, byEmail, apply: args.apply });
        if (r.reason === 'updated') changed++;
        else if (r.reason === 'skip:no_email') skippedNoEmail++;
        else if (r.reason === 'skip:no_active_subscription') skippedNoActive++;
        else if (r.reason === 'ok:already_synced') alreadyOk++;
        if (r.reason === 'updated' && r.change) changes.push(r.change);
      } catch (e: any) {
        errors++;
        console.warn('[WARN] sync failed', { clientId: doc.id, error: e?.message || String(e) });
      }
    }

    if (args.limit > 0 && scanned >= args.limit) break;
    if (scanned % 500 === 0) {
      console.log('… progress', { scanned, changed, alreadyOk, skippedNoEmail, skippedNoActive, errors });
    }
  }

  const finishedAt = new Date();

  console.log('✅ Terminé', { scanned, changed, alreadyOk, skippedNoEmail, skippedNoActive, errors });

  if (args.apply) {
    const reportPath = args.reportPath ? resolve(process.cwd(), args.reportPath) : reportDefaultPath();
    mkdirSync(resolve(reportPath, '..'), { recursive: true });
    const md = toMdReport({
      startedAtIso: startedAt.toISOString(),
      finishedAtIso: finishedAt.toISOString(),
      scanned,
      changed,
      alreadyOk,
      skippedNoEmail,
      skippedNoActive,
      errors,
      changes
    });
    writeFileSync(reportPath, md, 'utf8');
    console.log('📝 Rapport écrit:', reportPath);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('❌ Erreur fatale:', e);
    process.exit(1);
  });

