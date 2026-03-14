/**
 * backfill-conseillers-supabase-auth.ts
 *
 * Récupère tous les conseillers de la table `conseillers`, puis crée pour chacun
 * un utilisateur Supabase Auth avec le même id (conseiller.id = auth user id),
 * mot de passe Aa123456. Si l'utilisateur existe déjà en auth, met à jour le mot de passe.
 *
 * Usage:
 *   npx tsx scripts/backfill-conseillers-supabase-auth.ts           # exécution
 *   npx tsx scripts/backfill-conseillers-supabase-auth.ts --dry-run # simulation
 */

import * as dotenv from 'dotenv';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(ROOT, '.env.local') });
dotenv.config({ path: path.join(ROOT, '.env') });

const DRY_RUN = process.argv.includes('--dry-run');
const PASSWORD = 'Aa123456';

const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ SUPABASE_URL et SUPABASE_SECRET_KEY (ou SERVICE_ROLE_KEY) requis');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function main() {
  console.log('\n🔄 Backfill conseillers → Supabase Auth');
  if (DRY_RUN) console.log('   (mode simulation --dry-run)\n');

  const { data: conseillers, error: listErr } = await supabase
    .from('conseillers')
    .select('id, name, email')
    .order('created_at', { ascending: true });

  if (listErr) {
    console.error('❌ Erreur lecture table conseillers:', listErr.message);
    process.exit(1);
  }

  if (!conseillers?.length) {
    console.log('Aucun conseiller trouvé dans la table conseillers.');
    return;
  }

  console.log(`📋 ${conseillers.length} conseiller(s) trouvé(s)\n`);

  let created = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const c of conseillers) {
    const id = c.id as string;
    const name = (c.name || 'Conseiller').trim();
    const email = (c.email || '').trim().toLowerCase();
    const emailForAuth = email && email.includes('@') ? email : `conseiller-${id}@placeholder.olim.local`;

    if (DRY_RUN) {
      console.log(`  [DRY-RUN] ${name} (${emailForAuth}) id=${id}`);
      skipped++;
      continue;
    }

    // id personnalisé pour que auth.users.id = conseillers.id (requis pour le middleware)
    const { data: createData, error: createErr } = await supabase.auth.admin.createUser({
      id,
      email: emailForAuth,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { name, role: 'conseiller', backfill: true },
    } as { id: string; email: string; password: string; email_confirm: boolean; user_metadata: object });

    if (createErr) {
      if (createErr.message?.includes('already') || createErr.message?.includes('registered') || createErr.message?.includes('exists')) {
        const { error: updateErr } = await supabase.auth.admin.updateUserById(id, { password: PASSWORD, email_confirm: true });
        if (!updateErr) {
          console.log(`  ✅ ${name}: déjà en auth, mot de passe mis à jour`);
          updated++;
        } else {
          console.warn(`  ⚠️ ${name}:`, createErr.message);
          failed++;
        }
      } else {
        console.warn(`  ❌ ${name}:`, createErr.message);
        failed++;
      }
      continue;
    }

    if (createData?.user) {
      console.log(`  ✅ ${name}: créé en auth (id=${id})`);
      created++;
    } else {
      failed++;
    }
  }

  console.log('\n--- Résumé ---');
  console.log(`  Créés:   ${created}`);
  console.log(`  Mis à jour (mot de passe): ${updated}`);
  if (DRY_RUN) console.log(`  Simulés: ${skipped}`);
  if (failed) console.log(`  Échecs:  ${failed}`);
  console.log('\nMot de passe utilisé pour tous: Aa123456\n');
}

main().catch((err) => {
  console.error('❌ Erreur:', err);
  process.exit(1);
});
