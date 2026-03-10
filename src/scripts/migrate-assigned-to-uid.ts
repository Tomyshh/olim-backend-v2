/**
 * Migration script: populates `assigned_to_conseiller_id` in Supabase `requests` table
 * by matching the existing `assigned_to` (name string) against the `conseillers` table.
 * Uses conseillers.id (UUID) for the FK - every conseiller has an id.
 *
 * Usage:
 *   npx tsx src/scripts/migrate-assigned-to-uid.ts          # dry-run (default)
 *   npx tsx src/scripts/migrate-assigned-to-uid.ts --apply   # actually write
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

async function main() {
  console.log(`\n🔄 Migration assigned_to_conseiller_id on Supabase requests  (${DRY_RUN ? 'DRY RUN' : 'APPLY MODE'})\n`);

  const { data: conseillers, error: cErr } = await supabase
    .from('conseillers')
    .select('id, name');

  if (cErr) {
    console.error('❌ Failed to load conseillers:', cErr.message);
    process.exit(1);
  }

  const nameToConseillerId = new Map<string, string>();
  const firstNameToConseillerId = new Map<string, string>();

  for (const c of conseillers ?? []) {
    const name = (c.name ?? '').trim();
    const conseillerId = c.id;
    if (name && conseillerId) {
      nameToConseillerId.set(name.toLowerCase(), conseillerId);
      const firstName = name.split(' ')[0].toLowerCase();
      if (!firstNameToConseillerId.has(firstName)) {
        firstNameToConseillerId.set(firstName, conseillerId);
      }
    }
  }
  console.log(`📋 ${nameToConseillerId.size} conseillers loaded (${firstNameToConseillerId.size} unique first names)\n`);

  const PAGE_SIZE = 1000;
  let offset = 0;
  let totalProcessed = 0;
  let updated = 0;
  let skipped = 0;
  let notFound = 0;
  const notFoundNames = new Set<string>();

  while (true) {
    const { data: requests, error: rErr } = await supabase
      .from('requests')
      .select('id, assigned_to')
      .range(offset, offset + PAGE_SIZE - 1);

    if (rErr) {
      console.error('❌ Failed to load requests:', rErr.message);
      process.exit(1);
    }

    if (!requests || requests.length === 0) break;

    totalProcessed += requests.length;

    for (const req of requests) {
      const assignedTo = (req.assigned_to ?? '').trim();
      if (!assignedTo) {
        skipped++;
        continue;
      }

      let conseillerId = nameToConseillerId.get(assignedTo.toLowerCase());
      if (!conseillerId) {
        conseillerId = firstNameToConseillerId.get(assignedTo.toLowerCase());
      }

      if (!conseillerId) {
        notFound++;
        notFoundNames.add(assignedTo);
        continue;
      }

      if (!DRY_RUN) {
        const { error: uErr } = await supabase
          .from('requests')
          .update({ assigned_to_conseiller_id: conseillerId })
          .eq('id', req.id);

        if (uErr) {
          console.log(`  ⚠️  Failed to update request ${req.id}: ${uErr.message}`);
          continue;
        }
      }
      updated++;
    }

    console.log(`  📦 Processed ${totalProcessed} requests (updated: ${updated}, skipped: ${skipped}, not found: ${notFound})`);

    if (requests.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  console.log(`\n--- Summary ---`);
  console.log(`  Total requests:  ${totalProcessed}`);
  console.log(`  Would update:    ${updated}`);
  console.log(`  Skipped:         ${skipped} (no assigned_to value)`);
  console.log(`  Not found:       ${notFound} (name not matching any conseiller)`);

  if (notFoundNames.size > 0) {
    console.log(`\n  Unmatched names: ${[...notFoundNames].join(', ')}`);
  }

  if (DRY_RUN) {
    console.log('\nℹ️  This was a dry run. Pass --apply to write changes.\n');
  } else {
    console.log('\n✅ Migration complete.\n');
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('❌ Migration failed:', err);
  process.exit(1);
});
