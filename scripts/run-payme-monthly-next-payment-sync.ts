import dotenv from 'dotenv';
import path from 'path';
import { initializeFirebase } from '../src/config/firebase.js';
import { runDailyPaymeMonthlyNextPaymentDateSyncJob } from '../src/services/paymeMonthlyNextPaymentSync.service.js';

// Charger .env puis .env.local (si présent) pour les scripts manuels
dotenv.config();
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

function pickArg(name: string): string {
  const idx = process.argv.findIndex((x) => x === `--${name}`);
  if (idx >= 0) return String(process.argv[idx + 1] || '').trim();
  return '';
}

async function main(): Promise<void> {
  const clientId = pickArg('clientId');
  const apply = process.argv.includes('--apply');
  const dryRun = !apply;

  console.log('[scripts/run-payme-monthly-next-payment-sync] Initializing Firebase...');
  initializeFirebase();

  console.log('[scripts/run-payme-monthly-next-payment-sync] Starting job...', { clientId: clientId || null, mode: apply ? 'APPLY' : 'DRY-RUN' });
  try {
    const res = await runDailyPaymeMonthlyNextPaymentDateSyncJob({ dryRun, clientId: clientId || undefined });
    console.log('[scripts/run-payme-monthly-next-payment-sync] Done.', { res: res ? { runId: res.runId, stats: res.stats } : null });
    process.exit(0);
  } catch (err: any) {
    console.error('[scripts/run-payme-monthly-next-payment-sync] Failed:', err?.message || String(err));
    process.exit(1);
  }
}

main();

