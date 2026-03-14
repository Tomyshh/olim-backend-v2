/**
 * Force la réinitialisation du mot de passe de tous les conseillers dans Supabase Auth.
 * Récupère les conseillers (email) depuis la table, trouve chaque user auth par email,
 * puis appelle updateUserById avec le mot de passe Aa123456.
 *
 * À lancer avec le MÊME Supabase que le frontend CRM (ex: variables prod si le CRM est sur Render).
 *
 * Usage:
 *   npx tsx scripts/force-reset-conseillers-password.ts
 *   SUPABASE_URL=https://xxx.supabase.co SUPABASE_SERVICE_ROLE_KEY=xxx npx tsx scripts/force-reset-conseillers-password.ts
 */

import * as dotenv from 'dotenv';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(ROOT, '.env.local') });
dotenv.config({ path: path.join(ROOT, '.env') });

const PASSWORD = 'Aa123456';

const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ SUPABASE_URL et SUPABASE_SECRET_KEY (ou SERVICE_ROLE_KEY) requis');
  process.exit(1);
}

// Afficher l'URL pour vérifier qu'on cible le bon projet (celui du CRM)
console.log('\n🔐 Cible Supabase:', supabaseUrl);
console.log('   (Le CRM frontend doit utiliser cette même URL)\n');

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function listAllAuthUsers(): Promise<{ id: string; email: string | undefined }[]> {
  const users: { id: string; email: string | undefined }[] = [];
  let page = 1;
  const perPage = 1000;
  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error(`listUsers: ${error.message}`);
    if (!data?.users?.length) break;
    for (const u of data.users) {
      users.push({ id: u.id, email: u.email });
    }
    if (data.users.length < perPage) break;
    page++;
  }
  return users;
}

async function main() {
  const { data: conseillers, error: listErr } = await supabase
    .from('conseillers')
    .select('id, name, email')
    .order('created_at', { ascending: true });

  if (listErr) {
    console.error('❌ Erreur lecture conseillers:', listErr.message);
    process.exit(1);
  }

  if (!conseillers?.length) {
    console.log('Aucun conseiller dans la table.');
    return;
  }

  console.log(`📋 ${conseillers.length} conseiller(s) dans la table. Récupération des utilisateurs Auth...\n`);

  const authUsers = await listAllAuthUsers();
  const emailToAuthUser = new Map<string, { id: string; email: string }>();
  for (const u of authUsers) {
    if (u.email) emailToAuthUser.set(u.email.trim().toLowerCase(), { id: u.id, email: u.email });
  }

  let ok = 0;
  let notFound = 0;
  let failed = 0;

  for (const c of conseillers) {
    const name = (c.name || 'Conseiller').trim();
    const email = (c.email || '').trim().toLowerCase();
    if (!email || !email.includes('@')) {
      console.log(`  ⏭️ ${name}: pas d'email, ignoré`);
      continue;
    }

    const authUser = emailToAuthUser.get(email);
    if (!authUser) {
      console.log(`  ❌ ${name} (${email}): aucun utilisateur Auth trouvé avec cet email`);
      notFound++;
      continue;
    }

    const { error } = await supabase.auth.admin.updateUserById(authUser.id, {
      password: PASSWORD,
      email_confirm: true,
    });

    if (error) {
      console.warn(`  ⚠️ ${name}: updateUserById failed:`, error.message);
      failed++;
    } else {
      console.log(`  ✅ ${name} (${email}): mot de passe mis à jour`);
      ok++;
    }
  }

  console.log('\n--- Résumé ---');
  console.log(`  Mot de passe réinitialisé: ${ok}`);
  if (notFound) console.log(`  Non trouvés en Auth (email): ${notFound}`);
  if (failed) console.log(`  Erreurs: ${failed}`);
  console.log('\nMot de passe appliqué: Aa123456\n');
}

main().catch((err) => {
  console.error('❌', err);
  process.exit(1);
});
