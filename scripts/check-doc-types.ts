import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SECRET_KEY || '';
const s = createClient(supabaseUrl, supabaseKey, { auth: { autoRefreshToken: false, persistSession: false } });

async function main() {
  const { data: types } = await s.from('document_types').select('id, slug, label').limit(50);
  console.log('=== document_types table ===');
  for (const t of types || []) {
    console.log(`  slug: "${t.slug}" | label: "${t.label}"`);
  }

  const { data: docs } = await s
    .from('client_documents')
    .select('document_type')
    .not('document_type', 'is', null)
    .neq('document_type', '')
    .limit(1000);

  const counts = new Map<string, number>();
  for (const d of docs || []) {
    const t = d.document_type || '';
    counts.set(t, (counts.get(t) || 0) + 1);
  }

  console.log('\n=== unique document_type values in client_documents ===');
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [type, count] of sorted) {
    const matchLabel = (types || []).find((t) => t.label.toLowerCase().trim() === type.toLowerCase().trim());
    const matchSlug = (types || []).find((t) => t.slug.toLowerCase().trim() === type.toLowerCase().trim());
    const status = matchLabel ? '✅ label match' : matchSlug ? '✅ slug match' : '❌ NO MATCH';
    console.log(`  "${type}" (${count}x) → ${status}`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
