/**
 * Test de connexion Supabase Auth avec email/mot de passe
 * Usage: tsx scripts/test-supabase-login.ts [email] [password]
 * Exemple: tsx scripts/test-supabase-login.ts tomyyapp@gmail.com Aa123456
 */

import 'dotenv/config';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { Client as PgClient } from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(ROOT, '.env.local') });
dotenv.config({ path: path.join(ROOT, '.env') });

const email = process.argv[2] || 'tomyyapp@gmail.com';
const password = process.argv[3] || 'Aa123456';

const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

async function testViaApi() {
  const { createClient } = await import('@supabase/supabase-js');
  const supabase = createClient(supabaseUrl, supabaseAnonKey);

  console.log(`Test connexion Supabase Auth (API): ${email}\n`);

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    console.error('❌ Échec de connexion:', error.message);
    console.error('   Code:', error.name);
    return false;
  }

  console.log('✅ Connexion réussie !');
  console.log('   User ID:', data.user?.id);
  return true;
}

async function checkDbUser() {
  const supabaseCfgPath = path.join(ROOT, 'scripts/firebase-auth-migration/supabase-service.json');
  if (!fs.existsSync(supabaseCfgPath)) {
    console.error('supabase-service.json manquant');
    return null;
  }

  const cfg = JSON.parse(fs.readFileSync(supabaseCfgPath, 'utf8'));
  const dbPassword = cfg.password_base64?.startsWith('base64:')
    ? Buffer.from(cfg.password_base64.slice(7), 'base64').toString('utf8')
    : cfg.password;

  const projectRef = (cfg.user || '').replace(/^postgres\./, '') || 'jfkuzrjsouggkofxmyhu';
  const pg = new PgClient({
    host: `db.${projectRef}.supabase.co`,
    port: 5432,
    database: 'postgres',
    user: 'postgres',
    password: dbPassword,
    ssl: { rejectUnauthorized: false }
  });

  try {
    await pg.connect();
    const r = await pg.query(
      `SELECT id, email, left(encrypted_password, 80) as enc_pass_preview, length(encrypted_password) as enc_len
       FROM auth.users WHERE email = $1`,
      [email.toLowerCase()]
    );
    return r.rows[0] ?? null;
  } finally {
    await pg.end();
  }
}

async function main() {
  const ok = await testViaApi();
  if (ok) process.exit(0);

  console.log('\n--- Diagnostic : utilisateur dans auth.users ---\n');
  const row = await checkDbUser();
  if (row) {
    console.log('Utilisateur trouvé dans auth.users:');
    console.log('  id:', row.id);
    console.log('  email:', row.email);
    console.log('  encrypted_password (début):', row.enc_pass_preview);
    console.log('  encrypted_password (longueur):', row.enc_len);
    if (row.enc_pass_preview?.startsWith('$fbscrypt$')) {
      console.log('\n  Format $fbscrypt$ détecté. Si la connexion échoue :');
      console.log('  → Les paramètres hash (signer_key, salt_separator) dans hash-parameters.md');
      console.log('    doivent être EXACTEMENT ceux de votre projet Firebase.');
      console.log('  → Firebase Console → Authentication → Users → ⋮ → Password hash parameters');
      console.log('  → Copiez les valeurs, mettez à jour hash-parameters.md, relancez la migration.');
    }
  } else {
    console.log('Utilisateur non trouvé dans auth.users.');
  }

  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
