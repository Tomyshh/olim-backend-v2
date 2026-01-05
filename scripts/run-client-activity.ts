import 'dotenv/config';
import { initializeFirebase } from '../src/config/firebase.js';
import { computeClientActivityForClient, writeClientActivityForClient } from '../src/services/clientActivity.service.js';

function pickArg(name: string): string {
  const idx = process.argv.findIndex((x) => x === `--${name}`);
  if (idx >= 0) return String(process.argv[idx + 1] || '').trim();
  return '';
}

async function main(): Promise<void> {
  const allow = process.env.ACTIVITY_JOB_ALLOW_MANUAL === 'true';
  if (!allow) {
    console.error('Refus: set ACTIVITY_JOB_ALLOW_MANUAL=true pour exécuter ce script.');
    process.exit(2);
  }

  const clientId = pickArg('clientId') || String(process.env.CLIENT_ID || '').trim();
  if (!clientId) {
    console.error('clientId manquant. Utilise --clientId <uid> ou CLIENT_ID=<uid>.');
    process.exit(2);
  }

  const write = process.env.WRITE === 'true';
  const dryRun = !write;

  initializeFirebase();

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


