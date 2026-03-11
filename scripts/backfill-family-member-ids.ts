import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

/**
 * backfill-family-member-ids.ts
 *
 * Backfills `family_member_id` on `client_documents` by matching `for_who` text
 * against family_members names.
 * Also backfills `document_type_id` from `document_types`.
 *
 * Usage:
 *   npx tsx scripts/backfill-family-member-ids.ts
 *   npx tsx scripts/backfill-family-member-ids.ts --dry-run
 */

const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
if (!supabaseUrl || !supabaseKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SECRET_KEY');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const dryRun = process.argv.includes('--dry-run');

function normalize(s: string): string {
  return (s || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

async function backfillFamilyMemberIds() {
  console.log('=== Backfill family_member_id on client_documents ===');
  if (dryRun) console.log('  (DRY RUN – no writes)');

  // Fetch all documents missing family_member_id but having for_who
  const { data: docs, error: docsErr } = await supabase
    .from('client_documents')
    .select('id, client_id, for_who, family_member_id')
    .is('family_member_id', null)
    .not('for_who', 'is', null)
    .neq('for_who', '');

  if (docsErr) {
    console.error('Error fetching documents:', docsErr.message);
    return;
  }

  console.log(`Found ${docs?.length ?? 0} documents with for_who but no family_member_id`);
  if (!docs || docs.length === 0) return;

  // Get unique client_ids
  const clientIds = [...new Set(docs.map((d) => d.client_id))];
  console.log(`Across ${clientIds.length} clients`);

  // Fetch all family members for these clients
  const { data: members, error: memErr } = await supabase
    .from('family_members')
    .select('id, client_id, first_name, last_name')
    .in('client_id', clientIds);

  if (memErr) {
    console.error('Error fetching family_members:', memErr.message);
    return;
  }

  // Index members by client_id
  const membersByClient = new Map<string, any[]>();
  for (const m of members || []) {
    const list = membersByClient.get(m.client_id) || [];
    list.push(m);
    membersByClient.set(m.client_id, list);
  }

  let updated = 0;
  let noMatch = 0;

  for (const doc of docs) {
    const forWho = normalize(doc.for_who);
    if (!forWho) continue;

    const clientMembers = membersByClient.get(doc.client_id) || [];
    let matched: any = null;

    for (const m of clientMembers) {
      const fn = normalize(m.first_name ?? '');
      const ln = normalize(m.last_name ?? '');
      const fullName = normalize(`${m.first_name ?? ''} ${m.last_name ?? ''}`);
      const fullNameReversed = normalize(`${m.last_name ?? ''} ${m.first_name ?? ''}`);

      if (
        forWho === fullName ||
        forWho === fullNameReversed ||
        fullName.includes(forWho) ||
        forWho.includes(fullName) ||
        (fn && ln && forWho.includes(fn) && forWho.includes(ln))
      ) {
        matched = m;
        break;
      }
    }

    if (matched) {
      if (!dryRun) {
        await supabase
          .from('client_documents')
          .update({ family_member_id: matched.id })
          .eq('id', doc.id);
      }
      updated++;
      console.log(`  ✅ doc ${doc.id}: "${doc.for_who}" → member ${matched.id} (${matched.first_name} ${matched.last_name})`);
    } else {
      noMatch++;
      console.log(`  ❌ doc ${doc.id}: "${doc.for_who}" – no matching member found`);
    }
  }

  console.log(`\nResult: ${updated} updated, ${noMatch} unmatched`);
}

async function backfillDocumentTypeIds() {
  console.log('\n=== Backfill document_type_id on client_documents ===');

  // Check if column exists first
  const { data: testData, error: testErr } = await supabase
    .from('client_documents')
    .select('id, document_type_id')
    .limit(1);

  if (testErr && testErr.message?.includes('document_type_id')) {
    console.log('Column document_type_id does not exist yet – skipping');
    return;
  }

  // Fetch docs with document_type but no document_type_id
  const { data: docs, error: docsErr } = await supabase
    .from('client_documents')
    .select('id, document_type, document_type_id')
    .is('document_type_id', null)
    .not('document_type', 'is', null)
    .neq('document_type', '');

  if (docsErr) {
    console.error('Error:', docsErr.message);
    return;
  }

  console.log(`Found ${docs?.length ?? 0} documents needing document_type_id`);
  if (!docs || docs.length === 0) return;

  // Fetch all document_types
  const { data: types } = await supabase
    .from('document_types')
    .select('id, slug, label');

  if (!types || types.length === 0) {
    console.log('No document_types found – skipping');
    return;
  }

  // Build mapping: various document_type strings → document_types.id
  const typeMap = new Map<string, string>();
  for (const t of types) {
    typeMap.set(normalize(t.label), t.id);
    typeMap.set(normalize(t.slug), t.id);
  }

  // Common aliases from Firestore → matching document_types label
  const aliases: Record<string, string> = {
    'teoudat zeout': 'teoudat zehout',
    'teoudat zehut': 'teoudat zehout',
    'teudat zehut': 'teoudat zehout',
    'teoudat zehout': 'teoudat zehout',
    'tz': 'teoudat zehout',
    'teoudat olé': 'teoudat ole',
    'teoudat ole': 'teoudat ole',
    'passeport israelien': 'passeport',
    'passeport français': 'passeport etranger',
    'passeport francais': 'passeport etranger',
    'passport': 'passeport',
    'carte de crédit': 'carte de credit',
    "carte d'identité": "carte d'identite",
    'contrat de location/achat': 'contrat de location',
    "contrat de location ou acte de propriété": 'contrat de location',
    "facture d'éléctricité": "facture d'electricite",
    "facture d'electricité": "facture d'electricite",
    "facture de téléphone": 'facture de telephone',
    'facture': 'autre',
    "compteur d'électricité": "compteur d'electricite",
    "photo du compteur électrique": "compteur d'electricite",
    "photo du compteur d'eau": "compteur d'eau",
    "photo du compteur de gaz": "compteur de gaz",
    "photo ou pdf de l'avis de arnona": "facture d'arnona",
    "dernière facture d'arnona": "facture d'arnona",
    "facture d'arnona": "facture d'arnona",
    "photo ou pdf de la facture d'électricité": "facture d'electricite",
    "ancienne facture d'électricité": "facture d'electricite",
    "photo ou pdf de la facture d'eau": "facture d'eau",
    "ancienne facture d'eau": "facture d'eau",
    "photo ou pdf de la facture de gaz": "facture de gaz",
    "ancienne facture de gaz": "facture de gaz",
    'driving license': 'permis de conduire',
    "permis de conduire expiré": 'permis de conduire',
    'credit card': 'carte de credit',
    'home insurance': 'assurance habitation',
    'teoudat zeout': 'teoudat zehout',
  };

  // Build alias → id map
  for (const [alias, target] of Object.entries(aliases)) {
    const targetId = typeMap.get(normalize(target));
    if (targetId) {
      typeMap.set(normalize(alias), targetId);
    }
  }

  let updated = 0;
  for (const doc of docs) {
    const docType = normalize(doc.document_type);
    const matchId = typeMap.get(docType);
    if (matchId) {
      if (!dryRun) {
        await supabase
          .from('client_documents')
          .update({ document_type_id: matchId })
          .eq('id', doc.id);
      }
      updated++;
    }
  }
  console.log(`Updated ${updated} / ${docs.length}`);
}

async function main() {
  await backfillFamilyMemberIds();
  await backfillDocumentTypeIds();
  console.log('\nDone.');
  process.exit(0);
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
