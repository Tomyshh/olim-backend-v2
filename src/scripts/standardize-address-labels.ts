import 'dotenv/config';
import dotenv from 'dotenv';
import path from 'path';
if (process.env.NODE_ENV !== 'production') {
  dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
}
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '',
  process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const labelMap: Record<string, string> = {
  'Main address': 'Adresse principale',
  'כתובת ראשית': 'Adresse principale',
  'Primary address': 'Adresse principale',
  'primary': 'Adresse principale',
  'Maison': 'Domicile',
  'Home': 'Domicile',
  'Office': 'Bureau',
  'Work': 'Bureau',
  'Travail': 'Bureau',
};

async function main() {
  console.log('Standardisation des labels...');
  for (const [from, to] of Object.entries(labelMap)) {
    const { data } = await supabase
      .from('client_addresses')
      .update({ label: to, name: to })
      .eq('label', from)
      .select('id');
    const count = data?.length ?? 0;
    if (count > 0) console.log(`  "${from}" → "${to}": ${count} rows`);
  }

  const { data: nullData } = await supabase
    .from('client_addresses')
    .update({ label: 'Adresse' })
    .is('label', null)
    .select('id');
  const nullCount = nullData?.length ?? 0;
  if (nullCount > 0) console.log(`  NULL → "Adresse": ${nullCount} rows`);

  console.log('Done');
}

main().catch(console.error);
