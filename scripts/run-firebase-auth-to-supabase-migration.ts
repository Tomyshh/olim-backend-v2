/**
 * Migration Firebase Auth → Supabase Auth (avec mots de passe)
 *
 * GARANTIE : Firebase et Firestore ne sont PAS modifiés.
 *
 * Étapes :
 *  1. Supprime TOUS les utilisateurs Supabase Auth
 *  2. Exporte les utilisateurs Firebase via firebase auth:export (inclut passwordHash + salt)
 *  3. Importe dans Supabase auth.users avec le format $fbscrypt$ (Supabase supporte Firebase SCRYPT)
 *
 * Référence : https://github.com/supabase/auth/pull/1768
 * Format : $fbscrypt$v=1,n=<N>,r=<r>,p=<p>,ss=<salt_separator>,sk=<signer_key>$<salt>$<hash>
 *
 * Usage: npm run script:firebase-auth-to-supabase
 */

import 'dotenv/config';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

dotenv.config({ path: path.join(ROOT, '.env.local') });
dotenv.config({ path: path.join(ROOT, '.env') });

const SUPABASE_CONFIG   = path.join(ROOT, 'scripts/firebase-auth-migration/supabase-service.json');
const HASH_PARAMS_JSON  = path.join(ROOT, 'scripts/firebase-auth-migration/hash-parameters.json');
const HASH_PARAMS_MD    = path.join(ROOT, 'scripts/firebase-auth-migration/hash-parameters.md');
const EXPORT_FILE       = path.join(ROOT, 'tmp/firebase-auth-export-with-passwords.json');
const FIREBASE_PROJECT  = process.env.FIREBASE_PROJECT_ID || 'olimservice-7dbee';

// ─── Config ──────────────────────────────────────────────────────────────────

if (!fs.existsSync(SUPABASE_CONFIG)) {
  console.error('❌ supabase-service.json manquant');
  process.exit(1);
}

function loadHashParams(): { base64_signer_key: string; base64_salt_separator: string; rounds: number; mem_cost: number } {
  if (fs.existsSync(HASH_PARAMS_JSON)) {
    return JSON.parse(fs.readFileSync(HASH_PARAMS_JSON, 'utf8'));
  }
  if (fs.existsSync(HASH_PARAMS_MD)) {
    const md = fs.readFileSync(HASH_PARAMS_MD, 'utf8');
    const sk = md.match(/base64_signer_key:\s*([^\s,]+)/)?.[1]?.trim();
    const ss = md.match(/base64_salt_separator:\s*([^\s,]+)/)?.[1]?.trim();
    const r = parseInt(md.match(/rounds:\s*(\d+)/)?.[1] ?? '8', 10);
    const m = parseInt(md.match(/mem_cost:\s*(\d+)/)?.[1] ?? '14', 10);
    if (!sk || !ss) throw new Error('hash-parameters.md : base64_signer_key et base64_salt_separator requis');
    return { base64_signer_key: sk, base64_salt_separator: ss, rounds: r, mem_cost: m };
  }
  throw new Error('hash-parameters.json ou hash-parameters.md manquant');
}

function decodePassword(raw: string): string {
  const s = raw?.trim();
  if (!s) return '';
  if (s.startsWith('base64:')) {
    try {
      return Buffer.from(s.slice(7), 'base64').toString('utf8');
    } catch {
      return s;
    }
  }
  return s;
}

// Pour encoder un mot de passe en base64 : node -e "console.log('base64:'+Buffer.from('VOTRE_MOT_DE_PASSE','utf8').toString('base64'))"

const supabaseCfg = JSON.parse(fs.readFileSync(SUPABASE_CONFIG, 'utf8')) as Record<string, any>;
const hashParams = loadHashParams();

const dbPassword =
  decodePassword(supabaseCfg.password_base64 || '') ||
  decodePassword(supabaseCfg.password || '') ||
  decodePassword(process.env.SUPABASE_DB_PASSWORD || '');
if (!dbPassword) {
  console.error('❌ Mot de passe requis : supabase-service.json (champ password) ou variable SUPABASE_DB_PASSWORD');
  console.error('   Pour éviter les problèmes avec @ et autres caractères, utilisez base64:VOTRE_MOT_DE_PASSE_EN_BASE64');
  process.exit(1);
}
supabaseCfg.password = dbPassword;

// Essayer d'abord la connexion DIRECTE (recommandée pour migrations, évite SCRAM)
// Si "password authentication failed" → vérifier le mot de passe dans Supabase Dashboard
const usePooler = supabaseCfg.connection === 'pooler' || process.env.SUPABASE_USE_POOLER === '1';
if (!usePooler) {
  const projectRef = (supabaseCfg.user || '').replace(/^postgres\./, '') || 'jfkuzrjsouggkofxmyhu';
  supabaseCfg._originalHost = supabaseCfg.host;
  supabaseCfg._originalUser = supabaseCfg.user;
  supabaseCfg.host = `db.${projectRef}.supabase.co`;
  supabaseCfg.user = 'postgres';
  console.log('   Connexion DIRECTE (db.xxx.supabase.co)\n');
}

import { Client as PgClient } from 'pg';

interface FirebaseExportedUser {
  localId: string;
  email?: string;
  emailVerified?: boolean;
  passwordHash?: string;
  salt?: string;
  createdAt?: string;
  lastSignedInAt?: string;
  providerUserInfo?: Array<{ providerId: string }>;
}

// ─── Format $fbscrypt$ pour Supabase ─────────────────────────────────────────

function buildEncryptedPassword(
  passwordHash: string,
  salt: string,
  params: typeof hashParams
): string {
  const n = Math.pow(2, params.mem_cost);
  const r = params.rounds;
  const p = 1;
  const ss = params.base64_salt_separator;
  const sk = params.base64_signer_key;
  return `$fbscrypt$v=1,n=${n},r=${r},p=${p},ss=${ss},sk=${sk}$${salt}$${passwordHash}`;
}

function escapeSql(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "''");
}

function isoOrNull(ms?: string): string {
  if (!ms) return 'null';
  try {
    const n = parseInt(ms, 10);
    if (isNaN(n)) return 'null';
    return `'${new Date(n).toISOString()}'`;
  } catch {
    return 'null';
  }
}

function providerJson(data?: Array<{ providerId: string }>): string {
  const ps = (data || []).map((p) => {
    const id = (p.providerId || '').toLowerCase().replace('.com', '');
    return id === 'password' ? 'email' : id || 'email';
  });
  return `{"provider":"${ps[0] ?? 'email'}","providers":["${ps.join('","')}"]}`;
}

// ─── Step 1 : Wipe Supabase Auth ─────────────────────────────────────────────

async function wipeSupabaseAuth(pg: PgClient): Promise<void> {
  console.log('1. Suppression de tous les utilisateurs Supabase Auth...');
  const { rowCount } = await pg.query('DELETE FROM auth.users');
  console.log(`   ✅ ${rowCount ?? 0} utilisateurs supprimés\n`);
}

// ─── Step 2 : Export Firebase (firebase auth:export) ─────────────────────────

function exportFirebaseUsers(): FirebaseExportedUser[] {
  console.log('2. Export Firebase Auth (firebase auth:export — inclut mots de passe)...');
  const dir = path.dirname(EXPORT_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  try {
    execSync(
      `firebase auth:export "${EXPORT_FILE}" --format=JSON --project ${FIREBASE_PROJECT}`,
      { cwd: ROOT, stdio: 'pipe', encoding: 'utf8' }
    );
  } catch (e: any) {
    console.error('   ❌ firebase auth:export a échoué. Vérifiez :');
    console.error('      - firebase login');
    console.error('      - firebase use ou --project');
    throw e;
  }

  const data = JSON.parse(fs.readFileSync(EXPORT_FILE, 'utf8'));
  const users: FirebaseExportedUser[] = data.users || [];
  console.log(`   ✅ ${users.length} utilisateurs exportés\n`);
  return users;
}

// ─── Step 3 : Import dans Supabase avec $fbscrypt$ ────────────────────────────

function buildRow(u: FirebaseExportedUser): string {
  const email = (u.email || '').trim().toLowerCase();
  if (!email || !email.includes('@')) return '';

  const encPass =
    u.passwordHash && u.salt
      ? buildEncryptedPassword(u.passwordHash, u.salt, hashParams)
      : '';

  const meta = escapeSql(JSON.stringify({ firebase_uid: u.localId }));
  const prov = escapeSql(providerJson(u.providerUserInfo));
  const encPassEscaped = escapeSql(encPass);

  return `(
    '00000000-0000-0000-0000-000000000000', gen_random_uuid(),
    'authenticated', 'authenticated',
    '${escapeSql(email)}',
    '${encPassEscaped}',
    NOW(), /* email confirmé pour permettre connexion immédiate après migration */
    ${isoOrNull(u.createdAt)},
    '', null, '', null, '', '', null, null,
    '${prov}',
    '${meta}',
    false, NOW(), NOW(),
    null, null, '', '', null, '', 0
  )`;
}

async function importToSupabase(users: FirebaseExportedUser[], pg: PgClient): Promise<void> {
  console.log('3. Import dans Supabase auth.users (avec mots de passe $fbscrypt$)...');

  const valid = users.filter((u) => (u.email || '').trim().includes('@'));
  const withPassword = valid.filter((u) => u.passwordHash && u.salt);
  const withoutPassword = valid.length - withPassword.length;

  if (withoutPassword > 0) {
    console.log(`   ⚠️  ${withoutPassword} utilisateurs sans passwordHash (OAuth uniquement) — mot de passe vide`);
  }

  const BATCH = 100;
  let inserted = 0;

  for (let i = 0; i < valid.length; i += BATCH) {
    const batch = valid.slice(i, i + BATCH);
    const rows = batch.map(buildRow).filter(Boolean);
    if (rows.length === 0) continue;

    const sql = `INSERT INTO auth.users (
      instance_id, id, aud, role, email, encrypted_password,
      email_confirmed_at, invited_at,
      confirmation_token, confirmation_sent_at,
      recovery_token, recovery_sent_at,
      email_change_token_new, email_change, email_change_sent_at,
      last_sign_in_at, raw_app_meta_data, raw_user_meta_data, is_super_admin,
      created_at, updated_at,
      phone, phone_confirmed_at,
      phone_change, phone_change_token, phone_change_sent_at,
      email_change_token_current, email_change_confirm_status
    ) VALUES ${rows.join(',\n')}
    ON CONFLICT DO NOTHING`;

    const res = await pg.query(sql);
    inserted += res.rowCount ?? 0;
    console.log(`   ${Math.min(i + BATCH, valid.length)}/${valid.length}...`);
  }

  console.log(`   ✅ ${inserted} utilisateurs insérés (dont ${withPassword.length} avec mot de passe)\n`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function connectPg(): Promise<PgClient> {
  const opts = {
    host: supabaseCfg.host,
    port: supabaseCfg.port ?? 5432,
    database: supabaseCfg.database ?? 'postgres',
    user: supabaseCfg.user,
    password: supabaseCfg.password,
    ssl: { rejectUnauthorized: false }
  };
  const pg = new PgClient(opts);
  await pg.connect();
  return pg;
}

async function main(): Promise<void> {
  console.log('=== Migration Firebase Auth → Supabase Auth (avec mots de passe) ===\n');

  let pg: PgClient;
  try {
    pg = await connectPg();
  } catch (err: any) {
    const msg = err?.message || '';
    if (supabaseCfg._originalHost && (msg.includes('password') || msg.includes('SCRAM'))) {
      console.log('   ⚠️  Connexion directe échouée, tentative avec le pooler...\n');
      supabaseCfg.host = supabaseCfg._originalHost;
      supabaseCfg.user = supabaseCfg._originalUser;
      pg = await connectPg();
    } else {
      throw err;
    }
  }
  console.log('   ✅ Connecté à Supabase PostgreSQL\n');

  try {
    await wipeSupabaseAuth(pg);
    const users = exportFirebaseUsers();
    await importToSupabase(users, pg);

    const valid = users.filter((u) => (u.email || '').includes('@'));
    const withPw = valid.filter((u) => u.passwordHash && u.salt).length;

    console.log('=== Terminé ===');
    console.log('Firebase  : NON modifié');
    console.log('Firestore : NON touché');
    console.log(`Supabase  : ${valid.length} utilisateurs migrés`);
    console.log(`           ${withPw} avec mot de passe conservé (connexion inchangée)`);
  } finally {
    await pg.end();
  }
}

main().catch((err) => {
  console.error('❌ Erreur fatale :', err.message);
  const msg = (err?.message || '').toLowerCase();
  if (msg.includes('password') || msg.includes('authentication') || msg.includes('scram')) {
    console.error('\n💡 Vérifiez le mot de passe dans Supabase Dashboard → Project Settings → Database.');
    console.error('   Utilisez password_base64 pour les caractères spéciaux (@, etc.) :');
    console.error('   node -e "console.log(\'base64:\'+Buffer.from(\'VOTRE_MOT_DE_PASSE\',\'utf8\').toString(\'base64\'))"');
  }
  process.exit(1);
});
