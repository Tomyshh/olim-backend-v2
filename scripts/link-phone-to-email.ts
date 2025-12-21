import { config } from 'dotenv';
import { initializeFirebase, getAuth } from '../src/config/firebase.js';

config();

type Args = {
  email?: string;
  phone?: string;
  apply: boolean;
  forceDeletePhoneUser: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = { apply: false, forceDeletePhoneUser: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') args.apply = true;
    else if (a === '--force-delete-phone-user') args.forceDeletePhoneUser = true;
    else if (a === '--email') args.email = argv[++i];
    else if (a === '--phone') args.phone = argv[++i];
  }
  return args;
}

function usage(): never {
  console.log(
    [
      'Usage:',
      '  npm run script:link-phone-to-email -- --email <email> --phone <e164_phone> [--apply] [--force-delete-phone-user]',
      '',
      'Exemple (dry-run):',
      '  npm run script:link-phone-to-email -- --email leaderecoenergie@gmail.com --phone +972555002485',
      '',
      'Exemple (apply):',
      '  npm run script:link-phone-to-email -- --email leaderecoenergie@gmail.com --phone +972555002485 --apply',
      '',
      'Notes:',
      '- Par défaut, le script ne modifie rien (dry-run).',
      '- Il tente de libérer le numéro en retirant le phoneNumber du compte téléphone, puis désactive ce compte.',
      '- Si Firebase refuse la suppression du phoneNumber, tu peux utiliser --force-delete-phone-user (supprime le compte téléphone pour libérer le numéro).',
    ].join('\n')
  );
  process.exit(2);
}

function summarizeUser(u: any) {
  return {
    uid: u.uid,
    email: u.email ?? null,
    phoneNumber: u.phoneNumber ?? null,
    disabled: u.disabled ?? false,
    providers: (u.providerData ?? []).map((p: any) => p.providerId),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.email || !args.phone) usage();

  console.log('🔧 Script: lier téléphone à un compte email (Firebase Auth)');
  console.log(`- email (original): ${args.email}`);
  console.log(`- phone (à lier): ${args.phone}`);
  console.log(`- mode: ${args.apply ? 'APPLY (modifie prod)' : 'DRY-RUN (aucun changement)'}`);
  console.log('');

  initializeFirebase();
  const auth = getAuth();

  const emailUser = await auth.getUserByEmail(args.email);
  const phoneUser = await auth.getUserByPhoneNumber(args.phone).catch(() => null);

  console.log('Compte email trouvé:');
  console.log(JSON.stringify(summarizeUser(emailUser), null, 2));
  console.log('');

  if (!phoneUser) {
    console.log('Aucun compte "téléphone uniquement" trouvé pour ce numéro.');
    console.log('On va tenter d’attacher le numéro directement au compte email.');
  } else {
    console.log('Compte téléphone trouvé:');
    console.log(JSON.stringify(summarizeUser(phoneUser), null, 2));
    console.log('');
  }

  if (emailUser.phoneNumber === args.phone) {
    console.log('✅ Le compte email possède déjà ce numéro. Rien à faire.');
    if (phoneUser && phoneUser.uid !== emailUser.uid && !phoneUser.disabled) {
      console.log('⚠️ Un compte téléphone séparé existe encore. Il peut rester désactivé si tu le souhaites.');
    }
    process.exit(0);
  }

  if (phoneUser && phoneUser.uid === emailUser.uid) {
    console.log('✅ Le compte email et le compte téléphone sont déjà le même UID (déjà fusionné côté Auth).');
    process.exit(0);
  }

  // Plan d’actions
  console.log('Plan:');
  if (phoneUser) {
    console.log(`- (1) Libérer le numéro en le retirant du compte téléphone UID=${phoneUser.uid}`);
    console.log(`- (2) Désactiver le compte téléphone UID=${phoneUser.uid}`);
  }
  console.log(`- (3) Attacher le numéro au compte email UID=${emailUser.uid}`);
  console.log('');

  if (!args.apply) {
    console.log('DRY-RUN: ajoute --apply pour exécuter.');
    process.exit(0);
  }

  // (1) Libérer le numéro côté phoneUser
  if (phoneUser) {
    try {
      // Le SDK Admin accepte généralement null côté REST; on force via any pour permettre la suppression.
      await auth.updateUser(phoneUser.uid, { phoneNumber: null as any });
      console.log(`✅ Numéro retiré du compte téléphone UID=${phoneUser.uid}`);
    } catch (e: any) {
      console.error(`❌ Impossible de retirer le numéro du compte téléphone UID=${phoneUser.uid}: ${e?.message ?? e}`);
      if (!args.forceDeletePhoneUser) {
        console.error('➡️ Relance avec --force-delete-phone-user pour supprimer le compte téléphone (libère le numéro).');
        process.exit(1);
      }
      await auth.deleteUser(phoneUser.uid);
      console.log(`✅ Compte téléphone supprimé UID=${phoneUser.uid} (force-delete)`);
    }

    // (2) Désactiver le compte téléphone (si pas supprimé)
    const stillExists = await auth.getUser(phoneUser.uid).catch(() => null);
    if (stillExists) {
      await auth.updateUser(phoneUser.uid, { disabled: true });
      console.log(`✅ Compte téléphone désactivé UID=${phoneUser.uid}`);
    }
  }

  // (3) Attacher le numéro au compte email
  try {
    await auth.updateUser(emailUser.uid, { phoneNumber: args.phone });
    console.log(`✅ Numéro attaché au compte email UID=${emailUser.uid}`);
  } catch (e: any) {
    console.error(`❌ Impossible d’attacher le numéro au compte email UID=${emailUser.uid}: ${e?.message ?? e}`);
    process.exit(1);
  }

  console.log('');
  console.log('🎉 Terminé.');
}

main().catch((e) => {
  console.error('❌ Erreur fatale:', e);
  process.exit(1);
});


