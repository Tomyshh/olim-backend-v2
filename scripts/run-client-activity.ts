import 'dotenv/config';
import { initializeFirebase } from '../src/config/firebase.js';
import { computeClientActivityForClient, writeClientActivityForClient, runDailyClientActivityJob } from '../src/services/clientActivity.service.js';

function pickArg(name: string): string {
  const idx = process.argv.findIndex((x) => x === `--${name}`);
  if (idx >= 0) return String(process.argv[idx + 1] || '').trim();
  return '';
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  const allow = process.env.ACTIVITY_JOB_ALLOW_MANUAL === 'true';
  if (!allow) {
    console.error('Refus: set ACTIVITY_JOB_ALLOW_MANUAL=true pour exécuter ce script.');
    process.exit(2);
  }

  const runAll = hasFlag('all') || process.env.RUN_ALL === 'true';
  const clientId = pickArg('clientId') || String(process.env.CLIENT_ID || '').trim();

  if (!runAll && !clientId) {
    console.error('Usage:');
    console.error('  - Un seul client: --clientId <uid> ou CLIENT_ID=<uid>');
    console.error('  - Tous les clients: --all ou RUN_ALL=true');
    process.exit(2);
  }

  const write = process.env.WRITE === 'true';
  const dryRun = !write;

  initializeFirebase();

  if (runAll) {
    console.log('[client-activity] Lancement du job complet sur tous les clients...');
    if (dryRun) {
      console.error('[client-activity] ERREUR: Le mode --all nécessite WRITE=true (pas de dry-run pour le job complet).');
      process.exit(2);
    }
    const result = await runDailyClientActivityJob();
    if (result) {
      console.log('[client-activity] Job terminé:', {
        runId: result.runId,
        clientsScanned: result.clientsScanned,
        clientsUpdated: result.clientsUpdated,
        clientsFailed: result.clientsFailed,
        durationMs: result.finishedAt.getTime() - result.startedAt.getTime()
      });
    } else {
      console.log('[client-activity] Job ignoré (déjà en cours ou verrouillé)');
    }
    return;
  }

  // Mode single client
  const { activity } = await computeClientActivityForClient({ clientId });

  console.log('[client-activity] computed', {
    clientId,
    activity
  });

  if (dryRun) {
    console.log('[client-activity] dry-run: aucune écriture effectuée. Pour écrire: WRITE=true');
    return;
  }

  await writeClientActivityForClient({ clientId, activity });
  console.log('[client-activity] wrote activity to Clients/{clientId}.activity (merge=true)');
}

main().catch((e) => {
  console.error('Erreur:', e);
  process.exit(1);
});


