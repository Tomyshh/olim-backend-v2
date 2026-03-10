import 'dotenv/config';
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

import { initializeFirebase, getAuth, getFirestore } from '../src/config/firebase.js';
import { createClient } from '@supabase/supabase-js';

const EMAIL    = 'tom@dokal.life';
const PASSWORD = 'Aa123456';
const NAME     = 'Tom';

initializeFirebase();

const auth = getAuth();
const db   = getFirestore();

const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const supabase    = createClient(supabaseUrl, supabaseKey, {
  auth: { autoRefreshToken: false, persistSession: false }
});

async function main() {
  // 1. Create Firebase Auth user
  console.log('1. Creating Firebase Auth user...');
  let uid: string;
  try {
    const user = await auth.createUser({ email: EMAIL, password: PASSWORD });
    uid = user.uid;
    console.log(`   ✅ Firebase Auth user created: ${uid}`);
  } catch (err: any) {
    if (err.code === 'auth/email-already-exists') {
      const existing = await auth.getUserByEmail(EMAIL);
      uid = existing.uid;
      console.log(`   ⚠️  User already exists in Firebase Auth: ${uid}`);
      await auth.updateUser(uid, { password: PASSWORD });
      console.log(`   ✅ Firebase password updated to Aa123456`);
    } else {
      throw err;
    }
  }

  // 2. Create Firestore Conseillers2 document (same structure as Yaacov/David)
  console.log('2. Creating Firestore Conseillers2 document...');
  await db.collection('Conseillers2').doc(uid).set({
    mail: EMAIL,
    name: NAME,
    password: PASSWORD,
    isAdmin: true,
    superAdmin: true,
    isPresent: true,
    manage_elite: true,
    isFinance: true,
    now_request: 0,
    language: { fr: true, he: true, en: true },
    selectedLanguage: 'fr',
    createdAt: new Date()
  }, { merge: true });
  console.log(`   ✅ Firestore Conseillers2/${uid} created`);

  // 3. Create Supabase Auth user
  console.log('3. Creating Supabase Auth user...');
  let supabaseAuthId: string | null = null;
  try {
    const { data, error } = await supabase.auth.admin.createUser({
      email: EMAIL,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { firebase_uid: uid, role: 'directeur' }
    });
    if (error) {
      if (error.message?.includes('already been registered')) {
        const { data: list } = await supabase.auth.admin.listUsers();
        const found = list?.users?.find(u => u.email === EMAIL);
        supabaseAuthId = found?.id ?? null;
        console.log(`   ⚠️  Already exists in Supabase Auth: ${supabaseAuthId}`);
        if (supabaseAuthId) {
          await supabase.auth.admin.updateUserById(supabaseAuthId, { password: PASSWORD });
          console.log(`   ✅ Supabase password updated to Aa123456`);
        }
      } else {
        console.error('   ❌ Supabase Auth error:', error.message);
      }
    } else {
      supabaseAuthId = data.user?.id ?? null;
      console.log(`   ✅ Supabase Auth user created: ${supabaseAuthId}`);
    }
  } catch (e: any) {
    console.error('   ❌ Supabase Auth exception:', e.message);
  }

  // 4. Upsert Supabase conseillers table
  console.log('4. Upserting Supabase conseillers table...');
  // Find directeur role
  const { data: roleData } = await supabase
    .from('roles')
    .select('id')
    .ilike('slug', '%directeur%')
    .maybeSingle();

  const roleId = roleData?.id ?? null;
  if (roleId) {
    console.log(`   Found role "directeur": ${roleId}`);
  } else {
    console.log('   ⚠️  No "directeur" role found in roles table, will insert without role_id');
  }

  const { error: upsertErr } = await supabase
    .from('conseillers')
    .upsert({
      firebase_uid: uid,
      name: NAME,
      email: EMAIL,
      role_id: roleId,
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }, { onConflict: 'firebase_uid' });

  if (upsertErr) {
    console.error('   ❌ Supabase conseillers error:', upsertErr.message);
  } else {
    console.log('   ✅ Supabase conseillers row upserted');
  }

  console.log('\n========== DONE ==========');
  console.log(`Email:    ${EMAIL}`);
  console.log(`Password: ${PASSWORD}`);
  console.log(`UID:      ${uid}`);
  console.log('Roles:    isAdmin=true, superAdmin=true, isFinance=true, manage_elite=true');
}

main().catch(err => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});
