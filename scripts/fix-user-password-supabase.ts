/**
 * Corrige le mot de passe d'un utilisateur Supabase (workaround quand $fbscrypt$ échoue)
 * Met à jour le mot de passe en bcrypt via l'API admin.
 *
 * Usage: tsx scripts/fix-user-password-supabase.ts <email> <nouveau_mot_de_passe>
 * Exemple: tsx scripts/fix-user-password-supabase.ts tomyyapp@gmail.com Aa123456
 */

import 'dotenv/config';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(ROOT, '.env.local') });
dotenv.config({ path: path.join(ROOT, '.env') });

const email = process.argv[2]?.trim().toLowerCase();
const newPassword = process.argv[3];

if (!email || !newPassword) {
  console.error('Usage: tsx scripts/fix-user-password-supabase.ts <email> <mot_de_passe>');
  process.exit(1);
}

const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ SUPABASE_URL et SUPABASE_SECRET_KEY requis');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { autoRefreshToken: false, persistSession: false }
});

async function main() {
  console.log(`Mise à jour du mot de passe pour ${email}...\n`);

  const { data: listData, error: listErr } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (listErr) {
    console.error('❌ Erreur listUsers:', listErr.message);
    process.exit(1);
  }

  const user = listData?.users?.find((u) => u.email?.toLowerCase() === email);
  if (!user) {
    console.error('❌ Utilisateur non trouvé:', email);
    process.exit(1);
  }

  const { error: updateErr } = await supabase.auth.admin.updateUserById(user.id, {
    password: newPassword,
    email_confirm: true
  });
  if (updateErr) {
    console.error('❌ Erreur updateUserById:', updateErr.message);
    process.exit(1);
  }

  console.log('✅ Mot de passe mis à jour (bcrypt) et email confirmé. Vous pouvez maintenant vous connecter.');
}

main();
