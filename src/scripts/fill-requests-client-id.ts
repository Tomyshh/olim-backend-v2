/**
 * Remplit client_id des requests Supabase en faisant correspondre user_id (Firebase UID)
 * avec firebase_uid de la table clients.
 *
 * Usage:
 *   npx tsx src/scripts/fill-requests-client-id.ts          # dry-run
 *   npx tsx src/scripts/fill-requests-client-id.ts --apply   # exécute
 */

import 'dotenv/config';
import dotenv from 'dotenv';
import path from 'path';

if (process.env.NODE_ENV !== 'production') {
  dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
}

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || '';

const supabase = createClient(supabaseUrl, supabaseKey);

const DRY_RUN = !process.argv.includes('--apply');
const PAGE_SIZE = 1000;

async function main() {
  console.log(`\n🔄 Fill requests.client_id from user_id → clients.firebase_uid  (${DRY_RUN ? 'DRY RUN' : 'APPLY'})\n`);

  const uidToClientId = new Map<string, string>();
  let co = 0;
  while (true) {
    const { data: chunk, error: cErr } = await supabase
      .from('clients')
      .select('id, firebase_uid')
      .range(co, co + PAGE_SIZE - 1);
    if (cErr) throw new Error(`clients: ${cErr.message}`);
    if (!chunk?.length) break;
    for (const c of chunk) {
      const uid = (c.firebase_uid ?? '').trim();
      if (uid) uidToClientId.set(uid, c.id);
    }
    if (chunk.length < PAGE_SIZE) break;
    co += PAGE_SIZE;
  }
  console.log(`📋 ${uidToClientId.size} clients chargés (firebase_uid → id)\n`);

  let offset = 0;
  let total = 0;
  let updated = 0;
  let skipped = 0;
  let noMatch = 0;

  while (true) {
    const { data: requests, error: rErr } = await supabase
      .from('requests')
      .select('id, user_id, client_id')
      .range(offset, offset + PAGE_SIZE - 1);

    if (rErr) throw new Error(`requests: ${rErr.message}`);
    if (!requests?.length) break;

    total += requests.length;

    for (const req of requests) {
      const userId = (req.user_id ?? '').trim();
      if (!userId) {
        skipped++;
        continue;
      }

      const clientId = uidToClientId.get(userId);
      if (!clientId) {
        noMatch++;
        continue;
      }

      if (req.client_id === clientId) {
        skipped++;
        continue;
      }

      if (!DRY_RUN) {
        const { error: uErr } = await supabase
          .from('requests')
          .update({ client_id: clientId })
          .eq('id', req.id);

        if (uErr) {
          console.log(`  ⚠️  request ${req.id}: ${uErr.message}`);
          continue;
        }
      }
      updated++;
    }

    process.stdout.write(`\r  Traité: ${total} | mis à jour: ${updated} | ignorés: ${skipped} | sans match: ${noMatch}`);

    if (requests.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  console.log(`\n\n--- Résumé ---`);
  console.log(`  Total requests:  ${total}`);
  console.log(`  Mis à jour:      ${updated}`);
  console.log(`  Ignorés:         ${skipped} (déjà rempli ou user_id vide)`);
  console.log(`  Sans match:      ${noMatch} (user_id non trouvé dans clients.firebase_uid)`);

  if (DRY_RUN) {
    console.log('\nℹ️  Dry run. Pass --apply pour exécuter.\n');
  } else {
    console.log('\n✅ Terminé.\n');
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('❌ Erreur:', err);
  process.exit(1);
});
