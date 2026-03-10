/**
 * Nettoie TOUS les clients de Supabase (et données liées) + Supabase Auth (sauf conseillers),
 * puis relance la migration Firestore → Supabase.
 *
 * ⚠️ NE TOUCHE JAMAIS À FIRESTORE - lecture seule.
 *
 * Usage:
 *   npx tsx src/scripts/clean-supabase-clients-and-remigrate.ts          # dry-run
 *   npx tsx src/scripts/clean-supabase-clients-and-remigrate.ts --apply   # exécute
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

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { autoRefreshToken: false, persistSession: false }
});

const DRY_RUN = !process.argv.includes('--apply');
const BATCH = 500;

async function getAllClientIds(): Promise<string[]> {
  const ids: string[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await supabase.from('clients').select('id').range(offset, offset + BATCH - 1);
    if (error) throw new Error(`clients select: ${error.message}`);
    if (!data?.length) break;
    ids.push(...data.map((r: any) => r.id));
    if (data.length < BATCH) break;
    offset += BATCH;
  }
  return ids;
}

async function deleteInBatches(table: string, column: string, ids: string[], label: string) {
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH);
    if (!DRY_RUN) {
      const { error } = await supabase.from(table).delete().in(column, chunk);
      if (error) throw new Error(`${table}.${column}: ${error.message}`);
    }
    process.stdout.write(`\r  ${label}: ${Math.min(i + BATCH, ids.length)}/${ids.length}`);
  }
  console.log(`\r  ${label}: ${ids.length} rows`);
}

async function main() {
  console.log(`\n🧹 Clean Supabase clients + Auth (sauf conseillers) puis migration  (${DRY_RUN ? 'DRY RUN' : 'APPLY'})\n`);

  const { data: conseillers, error: cErr } = await supabase.from('conseillers').select('email');
  if (cErr) throw new Error(`conseillers: ${cErr.message}`);
  const conseillerEmails = new Set((conseillers ?? []).map((c: any) => (c.email ?? '').toLowerCase().trim()).filter(Boolean));
  console.log(`📋 ${conseillerEmails.size} emails conseillers à préserver\n`);

  const clientIds = await getAllClientIds();
  console.log(`📦 ${clientIds.length} clients à supprimer\n`);

  if (clientIds.length === 0) {
    console.log('Aucun client à supprimer.');
  } else if (!DRY_RUN) {
    console.log('Suppression des données liées aux clients...\n');

    const convIds: string[] = [];
    for (let i = 0; i < clientIds.length; i += BATCH) {
      const chunk = clientIds.slice(i, i + BATCH);
      const { data } = await supabase.from('chat_conversations').select('id').in('client_id', chunk);
      if (data) convIds.push(...data.map((r: any) => r.id));
    }
    if (convIds.length > 0) {
      for (let i = 0; i < convIds.length; i += BATCH) {
        const chunk = convIds.slice(i, i + BATCH);
        await supabase.from('chat_messages').delete().in('conversation_id', chunk);
      }
      console.log(`  chat_messages: ${convIds.length} conversations`);
    }
    await deleteInBatches('chat_conversations', 'client_id', clientIds, 'chat_conversations');

    const docIds = await (async () => {
      const ids: string[] = [];
      for (let i = 0; i < clientIds.length; i += BATCH) {
        const { data } = await supabase.from('client_documents').select('id').in('client_id', clientIds.slice(i, i + BATCH));
        if (data) ids.push(...data.map((r: any) => r.id));
      }
      return ids;
    })();
    if (docIds.length > 0) {
      for (let i = 0; i < docIds.length; i += BATCH) {
        const chunk = docIds.slice(i, i + BATCH);
        await supabase.from('client_document_files').delete().in('client_document_id', chunk);
      }
      console.log(`  client_document_files: ${docIds.length} rows`);
    }
    await deleteInBatches('client_documents', 'client_id', clientIds, 'client_documents');
    await deleteInBatches('client_addresses', 'client_id', clientIds, 'client_addresses');
    await deleteInBatches('client_devices', 'client_id', clientIds, 'client_devices');
    await deleteInBatches('client_fcm_tokens', 'client_id', clientIds, 'client_fcm_tokens');
    await deleteInBatches('client_phones', 'client_id', clientIds, 'client_phones');
    await deleteInBatches('family_members', 'client_id', clientIds, 'family_members');
    await deleteInBatches('payment_credentials', 'client_id', clientIds, 'payment_credentials');
    await deleteInBatches('subscription_events', 'client_id', clientIds, 'subscription_events');
    await deleteInBatches('promo_redemptions', 'client_id', clientIds, 'promo_redemptions');
    await deleteInBatches('subscriptions', 'client_id', clientIds, 'subscriptions');

    await deleteInBatches('notifications', 'client_id', clientIds, 'notifications');
    try { await deleteInBatches('notification_settings', 'client_id', clientIds, 'notification_settings'); } catch {}
    await deleteInBatches('appointments', 'client_id', clientIds, 'appointments');
    await deleteInBatches('favorite_requests', 'client_id', clientIds, 'favorite_requests');
    await deleteInBatches('request_drafts', 'client_id', clientIds, 'request_drafts');
    try { await deleteInBatches('support_tickets', 'client_id', clientIds, 'support_tickets'); } catch {}
    try { await deleteInBatches('health_requests', 'client_id', clientIds, 'health_requests'); } catch {}
    try { await deleteInBatches('refund_requests', 'client_id', clientIds, 'refund_requests'); } catch {}
    try { await deleteInBatches('subscription_change_quotes', 'client_id', clientIds, 'subscription_change_quotes'); } catch {}

    for (let i = 0; i < clientIds.length; i += BATCH) {
      const chunk = clientIds.slice(i, i + BATCH);
      await supabase.from('requests').update({ client_id: null }).in('client_id', chunk);
    }
    console.log(`  requests.client_id: nullifié pour ${clientIds.length} lignes`);

    await deleteInBatches('clients', 'id', clientIds, 'clients');
  }

  console.log('\n--- Supabase Auth ---\n');
  let page = 1;
  let deletedAuth = 0;
  let keptAuth = 0;
  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(`auth listUsers: ${error.message}`);
    const users = data?.users ?? [];
    if (users.length === 0) break;

    for (const u of users) {
      const email = (u.email ?? '').toLowerCase().trim();
      if (conseillerEmails.has(email)) {
        keptAuth++;
      } else {
        if (!DRY_RUN) {
          await supabase.auth.admin.deleteUser(u.id);
          deletedAuth++;
        } else {
          deletedAuth++;
        }
      }
    }
    console.log(`  Page ${page}: ${users.length} users (à supprimer: ${deletedAuth}, conservés: ${keptAuth})`);
    if (users.length < 1000) break;
    page++;
  }

  console.log(`\n✅ Nettoyage terminé. Auth: ${deletedAuth} supprimés, ${keptAuth} conseillers conservés.\n`);

  if (DRY_RUN) {
    console.log('ℹ️  Dry run. Pass --apply pour exécuter, puis relance la migration manuellement:\n');
    console.log('   npx tsx scripts/migrate-client-to-supabase.ts --all\n');
    process.exit(0);
  }

  console.log('🔄 Lancement de la migration Firestore → Supabase...\n');
  const { spawn } = await import('child_process');
  const child = spawn('npx', ['tsx', 'scripts/migrate-client-to-supabase.ts', '--all'], {
    cwd: process.cwd(),
    stdio: 'inherit',
    shell: true
  });
  child.on('close', (code) => process.exit(code ?? 0));
}

main().catch((err) => {
  console.error('❌ Erreur:', err);
  process.exit(1);
});
