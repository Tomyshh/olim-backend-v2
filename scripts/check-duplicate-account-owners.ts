import admin from 'firebase-admin';
import { readFileSync } from 'fs';
import { join } from 'path';

// ⚠️ SCRIPT EN LECTURE UNIQUEMENT - Aucune modification
const PROD_SERVICE_ACCOUNT_PATH = 'olimservice-7dbee-firebase-adminsdk-r13so-8e1912f7d8.json';
const PROD_PROJECT_ID = 'olimservice-7dbee';

interface ProblematicClient {
  clientId: string;
  accountOwnersCount: number;
  accountOwners: Array<{
    memberId: string;
    firstName?: string;
    lastName?: string;
    email?: string;
  }>;
}

/**
 * Fonction principale de vérification
 */
async function checkDuplicateAccountOwners() {
  try {
    console.log('🔍 VÉRIFICATION DES CLIENTS AVEC PLUSIEURS "Account owner"');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('⚠️  MODE LECTURE UNIQUEMENT - Aucune modification\n');
    
    // Lecture du fichier de clé de service PROD
    const serviceAccountPath = join(process.cwd(), PROD_SERVICE_ACCOUNT_PATH);
    const serviceAccount = JSON.parse(readFileSync(serviceAccountPath, 'utf8'));
    
    // Vérification de sécurité
    if (serviceAccount.project_id !== PROD_PROJECT_ID) {
      console.error('❌ ERREUR : Le projet n\'est pas PROD !');
      console.error(`   Projet détecté : ${serviceAccount.project_id}`);
      console.error(`   Projet attendu : ${PROD_PROJECT_ID}`);
      process.exit(1);
    }
    
    console.log(`✅ Connexion au projet : ${serviceAccount.project_id} (PROD)`);
    console.log('');
    
    // Initialisation de Firebase pour PROD
    const app = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      storageBucket: `${serviceAccount.project_id}.appspot.com`
    });
    
    const db = app.firestore();
    console.log('✅ Firebase PROD initialisé\n');
    
    // Récupération de tous les clients
    console.log('📋 Récupération de tous les clients...');
    const clientsSnapshot = await db.collection('Clients').get();
    console.log(`📦 ${clientsSnapshot.size} client(s) trouvé(s)\n`);
    
    const problematicClients: ProblematicClient[] = [];
    let processed = 0;
    
    // Parcourir chaque client
    for (const clientDoc of clientsSnapshot.docs) {
      processed++;
      const clientId = clientDoc.id;
      
      // Récupérer la sous-collection "Family Members"
      const familyMembersSnapshot = await db
        .collection('Clients')
        .doc(clientId)
        .collection('Family Members')
        .get();
      
      // Filtrer ceux qui ont "Family Member Status" = "Account owner"
      const accountOwners = familyMembersSnapshot.docs
        .filter(doc => {
          const data = doc.data();
          return data['Family Member Status'] === 'Account owner';
        })
        .map(doc => {
          const data = doc.data();
          return {
            memberId: doc.id,
            firstName: data['First Name'],
            lastName: data['Last Name'],
            email: data['Email']
          };
        });
      
      // Si 2 ou plus "Account owner", ajouter à la liste
      if (accountOwners.length >= 2) {
        problematicClients.push({
          clientId,
          accountOwnersCount: accountOwners.length,
          accountOwners
        });
      }
      
      if (processed % 50 === 0) {
        console.log(`⏳ ${processed}/${clientsSnapshot.size} clients vérifiés...`);
      }
    }
    
    console.log(`✅ Vérification terminée (${processed} clients)\n`);
    
    // Affichage des résultats
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📊 RÉSULTATS :');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    
    if (problematicClients.length === 0) {
      console.log('✅ Aucun problème détecté !');
      console.log('   Tous les clients ont au maximum 1 "Account owner".\n');
    } else {
      console.log(`⚠️  ${problematicClients.length} client(s) avec 2+ "Account owner" :\n`);
      
      problematicClients.forEach((client, index) => {
        console.log(`${index + 1}. Client ID: ${client.clientId}`);
        console.log(`   Nombre de "Account owner": ${client.accountOwnersCount}`);
        console.log(`   Détails des "Account owner":`);
        
        client.accountOwners.forEach((owner, ownerIndex) => {
          console.log(`      ${ownerIndex + 1}. Member ID: ${owner.memberId}`);
          if (owner.firstName || owner.lastName) {
            console.log(`         Nom: ${owner.firstName || ''} ${owner.lastName || ''}`.trim());
          }
          if (owner.email) {
            console.log(`         Email: ${owner.email}`);
          }
        });
        console.log('');
      });
      
      // Résumé
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log(`📋 RÉSUMÉ :`);
      console.log(`   - Total clients vérifiés : ${processed}`);
      console.log(`   - Clients avec problème : ${problematicClients.length}`);
      console.log(`   - Pourcentage : ${((problematicClients.length / processed) * 100).toFixed(2)}%`);
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    }
    
    // Fermer proprement l'app Firebase
    await app.delete();
    
  } catch (error: any) {
    console.error('\n❌ ERREUR FATALE:', error);
    console.error(error.stack);
    process.exit(1);
  }
}

// Exécuter le script
checkDuplicateAccountOwners();

