import 'dotenv/config';
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { autoRefreshToken: false, persistSession: false }
});

async function main() {
  if (!supabaseUrl || !supabaseKey) {
    console.error('❌ SUPABASE_URL and SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY) required');
    process.exit(1);
  }

  // 1. Delete ALL Supabase Auth users (paginated)
  console.log('1. Deleting all Supabase Auth users...');
  let totalDeleted = 0;
  let page = 1;
  const perPage = 100;

  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) {
      console.error('   ❌ listUsers error:', error.message);
      break;
    }
    const users = data?.users ?? [];
    if (users.length === 0) break;

    for (const user of users) {
      const { error: delErr } = await supabase.auth.admin.deleteUser(user.id);
      if (delErr) {
        console.error(`   ⚠️  Failed to delete ${user.email ?? user.id}:`, delErr.message);
      } else {
        totalDeleted++;
        if (totalDeleted % 50 === 0) console.log(`   Deleted ${totalDeleted} users...`);
      }
    }
    if (users.length < perPage) break;
    page++;
  }
  console.log(`   ✅ Supabase Auth: ${totalDeleted} users deleted`);

  // 2. Clear auth_user_id in requests table
  console.log('2. Clearing auth_user_id in requests table...');
  const { count: updCount, error: updErr } = await supabase
    .from('requests')
    .update({ auth_user_id: null }, { count: 'exact' })
    .not('auth_user_id', 'is', null);

  if (updErr) {
    if (updErr.message?.includes('auth_user_id') || updErr.message?.includes('column')) {
      console.log('   ⚠️  Column auth_user_id may not exist in requests (error:', updErr.message, ')');
    } else {
      console.error('   ❌ Update error:', updErr.message);
    }
  } else {
    console.log(`   ✅ Cleared auth_user_id in requests (affected: ${updCount ?? '?'} rows)`);
  }

  console.log('\n========== DONE ==========');
  console.log('Firebase Auth: NOT modified');
  console.log(`Supabase Auth: ${totalDeleted} users removed`);
  console.log('requests.auth_user_id: cleared');
}

main().catch(err => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});
