import { config } from 'dotenv';
import { createWriteStream, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import admin from 'firebase-admin';
import { initializeFirebase, getFirestore } from '../src/config/firebase.js';

config();

type Args = {
  outPath: string;
  format: 'email' | 'name-angle';
  dedupe: boolean;
  pageSize: number;
};

function parseArgs(argv: string[]): Args & { help?: boolean } {
  const args: Args & { help?: boolean } = {
    outPath: resolve(process.cwd(), 'CLIENTS_EMAILS_MAILGUN.csv'),
    format: 'email',
    dedupe: true,
    pageSize: 1000,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--out') args.outPath = resolve(process.cwd(), argv[++i] ?? '');
    else if (a === '--format') {
      const v = (argv[++i] ?? '').toLowerCase();
      if (v === 'email' || v === 'name-angle') args.format = v;
      else throw new Error(`Valeur invalide pour --format: "${v}". Attendu: "email" ou "name-angle".`);
    } else if (a === '--no-dedupe') args.dedupe = false;
    else if (a === '--page-size') {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n <= 0) throw new Error(`Valeur invalide pour --page-size: "${n}"`);
      args.pageSize = Math.min(Math.floor(n), 5000);
    }
  }

  return args;
}

function usage(): string {
  return [
    'Script: export des emails de la collection Firestore "Clients" (champ "Email")',
    '',
    'Objectif: générer un fichier CSV compatible "Mailgun bulk upload" (1 destinataire par ligne).',
    'ATTENTION: lecture seule (aucune écriture/suppression/modification en base).',
    '',
    'Usage:',
    '  npx tsx scripts/export-client-emails-mailgun.ts [options]',
    '',
    'Options:',
    '  --out <fichier>        Chemin du CSV (défaut: ./CLIENTS_EMAILS_MAILGUN.csv)',
    '  --format <email|name-angle>',
    '                         "email" -> une ligne = email',
    '                         "name-angle" -> si nom dispo: "Prénom Nom <email>" sinon email',
    '  --no-dedupe            Ne pas dédupliquer (défaut: déduplication active)',
    '  --page-size <n>        Taille de page Firestore (défaut 1000, max 5000)',
    '  -h, --help             Affiche cette aide',
    '',
    'Exemples:',
    '  npx tsx scripts/export-client-emails-mailgun.ts',
    '  npx tsx scripts/export-client-emails-mailgun.ts --out exports/clients.csv',
    '  npx tsx scripts/export-client-emails-mailgun.ts --format name-angle',
  ].join('\n');
}

function sanitizeDisplayName(name: string): string {
  return name
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[<>"]/g, '') // éviter de casser le format "Nom <email>"
    .replace(/\s+/g, ' ')
    .trim();
}

function extractEmails(raw: unknown): string[] {
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v !== 'string') return;
    const s = v.trim();
    if (!s) return;
    out.push(s);
  };

  if (Array.isArray(raw)) {
    for (const v of raw) push(v);
  } else {
    push(raw);
  }
  return out;
}

function buildName(data: Record<string, any>): string | null {
  const first =
    (typeof data['First Name'] === 'string' ? data['First Name'] : undefined) ||
    (typeof data['Father Name'] === 'string' ? data['Father Name'] : undefined) ||
    (typeof data.firstName === 'string' ? data.firstName : undefined);
  const last =
    (typeof data['Last Name'] === 'string' ? data['Last Name'] : undefined) ||
    (typeof data.lastName === 'string' ? data.lastName : undefined);
  const full = `${first ?? ''} ${last ?? ''}`.trim();
  return full ? sanitizeDisplayName(full) : null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    process.exit(0);
  }

  console.log('📧 Script: export des emails (Firestore -> Mailgun CSV)');
  console.log('- collection: Clients');
  console.log('- champ email: Email');
  console.log(`- format: ${args.format}`);
  console.log(`- déduplication: ${args.dedupe ? 'OUI' : 'NON'}`);
  console.log(`- page-size: ${args.pageSize}`);
  console.log(`- sortie: ${args.outPath}`);
  console.log('');
  console.log('⚠️ Sécurité: LECTURE SEULE - aucune modification en base.');
  console.log('');

  initializeFirebase();
  const db = getFirestore();

  mkdirSync(dirname(args.outPath), { recursive: true });
  const stream = createWriteStream(args.outPath, { encoding: 'utf8' });

  const seen = args.dedupe ? new Set<string>() : null;
  let written = 0;
  let scanned = 0;

  let lastDoc: admin.firestore.QueryDocumentSnapshot | null = null;

  while (true) {
    let q = db
      .collection('Clients')
      .orderBy(admin.firestore.FieldPath.documentId())
      .limit(args.pageSize);

    if (lastDoc) q = q.startAfter(lastDoc);

    const snap = await q.get();
    if (snap.empty) break;

    for (const doc of snap.docs) {
      scanned++;
      const data = doc.data() as Record<string, any>;

      const emails = extractEmails(data.Email ?? data.email);
      if (emails.length === 0) continue;

      const name = args.format === 'name-angle' ? buildName(data) : null;

      for (const email of emails) {
        const key = email.trim().toLowerCase();
        if (seen) {
          if (seen.has(key)) continue;
          seen.add(key);
        }

        const line = args.format === 'name-angle' && name ? `${name} <${email.trim()}>` : email.trim();
        stream.write(line + '\n');
        written++;
      }
    }

    lastDoc = snap.docs[snap.docs.length - 1] ?? null;

    if (scanned % 5000 === 0) {
      console.log(`… progression: ${scanned} documents scannés, ${written} ligne(s) écrite(s)`);
    }
  }

  await new Promise<void>((resolvePromise, rejectPromise) => {
    stream.end(() => resolvePromise());
    stream.on('error', rejectPromise);
  });

  console.log('');
  console.log('✅ Terminé.');
  console.log(`- documents scannés: ${scanned}`);
  console.log(`- lignes écrites: ${written}`);
  console.log(`- fichier: ${args.outPath}`);
}

main().catch((e) => {
  console.error('❌ Erreur fatale:', e);
  process.exit(1);
});

