import { config } from 'dotenv';
import { readFileSync } from 'fs';
import { join } from 'path';
import { initializeFirebase, getFirestore } from '../src/config/firebase.js';

config();

type Args = {
  apply: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = { apply: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') args.apply = true;
  }
  return args;
}

function readProjectIdFromServiceAccount(): { serviceAccountPath: string; projectId: string } {
  const serviceAccountPath =
    process.env.FIREBASE_SERVICE_ACCOUNT_PATH || 'olimservice-7dbee-firebase-adminsdk-r13so-8e1912f7d8.json';
  const raw = readFileSync(join(process.cwd(), serviceAccountPath), 'utf8');
  const json = JSON.parse(raw);
  return { serviceAccountPath, projectId: json?.project_id ?? 'UNKNOWN_PROJECT_ID' };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const { serviceAccountPath, projectId } = readProjectIdFromServiceAccount();

  console.log('🔧 Script: upsert du document Utils/membership_details (Firestore)');
  console.log(`- projet (service account): ${projectId}`);
  console.log(`- chemin clé: ${serviceAccountPath}`);
  console.log(`- mode: ${args.apply ? 'APPLY (écrit en prod)' : 'DRY-RUN (aucun changement)'}`);
  console.log('');
  console.log('⚠️ Sécurité: ce script ne touche QU’À la collection "Utils", document "membership_details".');
  console.log('');

  const payload = {
    list: {
      // Français
      start: [
        'Remplissage de formulaires simples',
        'Prise de rendez-vous',
        "Création d'un espace personnel administratif",
        'Explication, traductions de tous vos documents en hébreu',
        'Paiement en ligne',
        'Demande de renseignements',
        "Vérification d'éligibilité",
      ],
      essential: [
        'Remplissage de tous types de formulaires',
        'Achats sur internet',
        'Assistance à distance sur ordinateur',
        'Mise en ligne',
        'Traitement',
        'Inscription',
        'Enregistrement aux organismes (Arnona, Eau, Électricité, Gaz)',
        'Vos demandes',
        'Appel',
        'Opération',
        'Conversation à trois',
      ],
      vip: [
        'Niveau de priorité 3/4 - Traitement dans les 6 heures',
        'Possibilité de faire vos demandes par WhatsApp',
        'Commandes immédiates de taxi, restaurants, etc.',
        "Achat et modification de billets d'avion",
        'Possibilité de demandes professionnelles',
      ],
      elite: ['Ligne directe', 'WhatsApp direct avec votre conseiller personnel'],

      // English
      start_en: [
        'Filling out simple forms',
        'Appointment booking',
        'Creation of a personal administrative space',
        'Explanation and translation of all your documents into Hebrew',
        'Online payment',
        'Information requests',
        'Eligibility check',
      ],
      essential_en: [
        'Filling out all types of forms',
        'Online shopping',
        'Remote computer assistance',
        'Online submission',
        'Processing',
        'Registration',
        'Registration with municipal/public utilities (Arnona, Water, Electricity, Gas)',
        'Your requests',
        'Phone call',
        'Operation',
        'Three-way call',
      ],
      vip_en: [
        'Priority level 3/4 - processed within 6 hours',
        'Ability to submit requests via WhatsApp',
        'Immediate booking/orders for taxis, restaurants, etc.',
        'Purchase and modification of flight tickets',
        'Option for professional requests',
      ],
      elite_en: ['Direct line', 'Direct WhatsApp with your personal advisor'],
    },
  };

  initializeFirebase();
  const db = getFirestore();

  const ref = db.collection('Utils').doc('membership_details');

  const before = await ref.get();
  console.log(`État actuel: ${before.exists ? 'EXISTE déjà' : 'N’EXISTE pas (sera créé)'}`);
  if (before.exists) {
    console.log('Aperçu (clé "list") avant:');
    console.log(JSON.stringify(before.data()?.list ?? null, null, 2));
  }
  console.log('');

  console.log('Payload à écrire (clé "list"):');
  console.log(JSON.stringify(payload.list, null, 2));
  console.log('');

  if (!args.apply) {
    console.log('DRY-RUN: ajoute --apply pour exécuter l’écriture.');
    process.exit(0);
  }

  await ref.set(payload, { merge: true });

  const after = await ref.get();
  console.log('✅ Écriture terminée.');
  console.log('Aperçu (clé "list") après:');
  console.log(JSON.stringify(after.data()?.list ?? null, null, 2));
}

main().catch((e) => {
  console.error('❌ Erreur fatale:', e);
  process.exit(1);
});


