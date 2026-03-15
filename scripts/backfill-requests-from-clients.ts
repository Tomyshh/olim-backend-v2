import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.join(process.cwd(), '.env.local'), override: true });
dotenv.config({ path: path.join(process.cwd(), '.env') });

import { createClient } from '@supabase/supabase-js';

/**
 * backfill-requests-from-clients.ts
 *
 * Fills missing client info (first_name, last_name, email, phone, membership_type)
 * and missing IDs (client_id, assigned_to_conseiller_id, category_id, sub_category_id)
 * in the `requests` table by reading from the `clients` and `conseillers` tables.
 *
 * Pure Supabase (no Firestore needed).
 *
 * Usage:
 *   npx tsx scripts/backfill-requests-from-clients.ts              # full backfill
 *   npx tsx scripts/backfill-requests-from-clients.ts --dry-run     # preview only
 */

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
if (!supabaseUrl || !supabaseKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SECRET_KEY');
  process.exit(1);
}
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const DRY_RUN = process.argv.includes('--dry-run');

// ---------------------------------------------------------------------------
// Load all clients and conseillers into memory
// ---------------------------------------------------------------------------
interface ClientInfo {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  membership_type: string | null;
}

const clientsByUid = new Map<string, ClientInfo>();
const clientsById = new Map<string, ClientInfo>();
const conseillersByName = new Map<string, string>();

async function loadClients(): Promise<void> {
  let offset = 0;
  while (true) {
    const { data } = await supabase
      .from('clients')
      .select('id, firebase_uid, first_name, last_name, email, phone, membership_type')
      .range(offset, offset + 999);
    if (!data?.length) break;
    for (const c of data) {
      const info: ClientInfo = {
        id: c.id,
        first_name: c.first_name || null,
        last_name: c.last_name || null,
        email: c.email || null,
        phone: c.phone || null,
        membership_type: c.membership_type || null,
      };
      if (c.firebase_uid) clientsByUid.set(c.firebase_uid, info);
      clientsById.set(c.id, info);
    }
    if (data.length < 1000) break;
    offset += 1000;
  }
  console.log(`  Loaded ${clientsByUid.size} clients`);
}

async function loadConseillers(): Promise<void> {
  let offset = 0;
  while (true) {
    const { data } = await supabase
      .from('conseillers')
      .select('id, name')
      .range(offset, offset + 999);
    if (!data?.length) break;
    for (const c of data) {
      if (c.name) conseillersByName.set(c.name.trim().toLowerCase(), c.id);
    }
    if (data.length < 1000) break;
    offset += 1000;
  }
  console.log(`  Loaded ${conseillersByName.size} conseillers`);
}

function resolveClient(req: any): ClientInfo | null {
  if (req.client_id) {
    const c = clientsById.get(req.client_id);
    if (c) return c;
  }
  if (req.user_id) {
    const c = clientsByUid.get(req.user_id);
    if (c) return c;
  }
  return null;
}

function resolveConseillerId(name: string | null): string | null {
  if (!name) return null;
  return conseillersByName.get(name.trim().toLowerCase()) ?? null;
}

// ---------------------------------------------------------------------------
// Main backfill
// ---------------------------------------------------------------------------
async function backfill(): Promise<void> {
  console.log(`\n=== BACKFILL REQUESTS FROM CLIENTS ${DRY_RUN ? '(DRY RUN) ' : ''}===\n`);
  console.log('  Loading caches...');
  await loadClients();
  await loadConseillers();

  let totalRequests = 0;
  let updated = 0;
  let skipped = 0;
  let noClient = 0;
  let errors = 0;
  let offset = 0;
  const batchSize = 500;

  while (true) {
    const { data: requests, error: fetchErr } = await supabase
      .from('requests')
      .select('id, user_id, client_id, first_name, last_name, email, phone, membership_type, assigned_to, assigned_to_conseiller_id')
      .range(offset, offset + batchSize - 1)
      .order('created_at', { ascending: true });

    if (fetchErr) {
      console.error('  Fetch error:', fetchErr.message);
      errors++;
      break;
    }
    if (!requests?.length) break;

    for (const req of requests) {
      totalRequests++;
      const client = resolveClient(req);

      const patch: Record<string, any> = {};

      // Fill client_id if missing
      if (!req.client_id && client) {
        patch.client_id = client.id;
      }

      // Fill client info from clients table when missing on the request
      if (client) {
        if (!req.first_name && client.first_name) patch.first_name = client.first_name;
        if (!req.last_name && client.last_name) patch.last_name = client.last_name;
        if (!req.email && client.email) patch.email = client.email;
        if (!req.phone && client.phone) patch.phone = client.phone;
        if (!req.membership_type && client.membership_type) patch.membership_type = client.membership_type;
      } else {
        noClient++;
      }

      // Fill assigned_to_conseiller_id if missing but assigned_to is set
      if (!req.assigned_to_conseiller_id && req.assigned_to) {
        const cid = resolveConseillerId(req.assigned_to);
        if (cid) patch.assigned_to_conseiller_id = cid;
      }

      if (Object.keys(patch).length === 0) {
        skipped++;
        continue;
      }

      if (DRY_RUN) {
        updated++;
        continue;
      }

      const { error: updateErr } = await supabase
        .from('requests')
        .update(patch)
        .eq('id', req.id);

      if (updateErr) {
        errors++;
        if (errors <= 5) console.error(`  Update error for ${req.id}:`, updateErr.message);
      } else {
        updated++;
      }
    }

    offset += batchSize;
    process.stdout.write(`\r  Processed ${totalRequests} requests | ${updated} updated | ${skipped} already complete | ${errors} errors`);

    if (requests.length < batchSize) break;
  }

  console.log('\n\n=== REPORT ===');
  console.log(`Total requests:   ${totalRequests}`);
  console.log(`Updated:          ${updated}`);
  console.log(`Already complete: ${skipped}`);
  console.log(`No client found:  ${noClient}`);
  console.log(`Errors:           ${errors}`);
}

backfill()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
