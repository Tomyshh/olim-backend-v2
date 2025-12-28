import { initializeFirebase, getFirestore } from '../src/config/firebase.js';
import admin from 'firebase-admin';

/**
 * Script pour récupérer la liste des clients avec les critères suivants :
 * - modifiedBy: "SYSTEM_REGISTRATION"
 * - membership: "Visitor"
 * - startDate entre le 14/12/2025 et le 22/12/2025
 * 
 * ATTENTION : Ce script est en LECTURE SEULE - aucune modification ne sera effectuée
 */

interface ClientData {
  clientId: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  membership?: string;
  modifiedBy?: string;
  startDate?: any;
  createdFrom?: string;
}

async function listSystemRegistrationClients() {
  console.log('🔍 Début de la recherche des clients...\n');
  console.log('📋 Critères de recherche :');
  console.log('   - modifiedBy: "SYSTEM_REGISTRATION"');
  console.log('   - membership: "Visitor"');
  console.log('   - startDate: entre le 14/12/2025 et le 22/12/2025\n');
  console.log('─'.repeat(80));

  try {
    // Initialiser Firebase
    initializeFirebase();
    const db = getFirestore();

    // Dates de filtrage
    const startDateMin = admin.firestore.Timestamp.fromDate(new Date('2025-12-14T00:00:00Z'));
    const startDateMax = admin.firestore.Timestamp.fromDate(new Date('2025-12-22T23:59:59Z'));

    console.log('\n📅 Période de recherche :');
    console.log(`   Du: ${startDateMin.toDate().toLocaleDateString('fr-FR')}`);
    console.log(`   Au: ${startDateMax.toDate().toLocaleDateString('fr-FR')}\n`);
    console.log('─'.repeat(80));

    // Récupérer tous les clients
    const clientsSnapshot = await db.collection('Clients').get();
    console.log(`\n📊 Total de clients dans la base : ${clientsSnapshot.size}`);
    console.log('🔄 Analyse en cours...\n');

    const matchingClients: ClientData[] = [];
    let clientsChecked = 0;

    // Parcourir chaque client
    for (const clientDoc of clientsSnapshot.docs) {
      clientsChecked++;
      
      if (clientsChecked % 100 === 0) {
        console.log(`   Progression : ${clientsChecked}/${clientsSnapshot.size} clients analysés...`);
      }

      const clientId = clientDoc.id;
      const clientData = clientDoc.data();

      // Vérifier si la sous-collection subscription/current existe
      try {
        const currentSubDoc = await db
          .collection('Clients')
          .doc(clientId)
          .collection('subscription')
          .doc('current')
          .get();

        if (currentSubDoc.exists) {
          const subData = currentSubDoc.data();
          
          // Vérifier les critères
          const hasSystemRegistration = subData?.history?.modifiedBy === 'SYSTEM_REGISTRATION';
          const isVisitor = subData?.plan?.membership === 'Visitor';
          const startDate = subData?.dates?.startDate;

          // Vérifier la date
          let isInDateRange = false;
          if (startDate) {
            const startTimestamp = startDate as admin.firestore.Timestamp;
            isInDateRange = startTimestamp >= startDateMin && startTimestamp <= startDateMax;
          }

          // Si tous les critères sont remplis
          if (hasSystemRegistration && isVisitor && isInDateRange) {
            matchingClients.push({
              clientId,
              firstName: clientData['First Name'] || clientData['Father Name'],
              lastName: clientData['Last Name'],
              email: clientData.Email,
              phone: Array.isArray(clientData['Phone Number']) 
                ? clientData['Phone Number'][0] 
                : clientData['Phone Number'],
              membership: subData.plan?.membership,
              modifiedBy: subData.history?.modifiedBy,
              startDate: startDate ? (startDate as admin.firestore.Timestamp).toDate() : undefined,
              createdFrom: clientData['Created From'] || clientData.createdVia
            });
          }
        }
      } catch (error) {
        // Ignorer les erreurs de lecture de sous-collection
        continue;
      }
    }

    console.log('\n' + '─'.repeat(80));
    console.log('\n✅ Analyse terminée !');
    console.log(`\n📊 RÉSULTATS : ${matchingClients.length} client(s) trouvé(s)\n`);
    console.log('═'.repeat(80));

    if (matchingClients.length === 0) {
      console.log('\n❌ Aucun client ne correspond aux critères spécifiés.');
    } else {
      console.log('\n📋 LISTE DES CLIENTS CORRESPONDANTS :\n');
      
      matchingClients.forEach((client, index) => {
        console.log(`\n┌─ Client ${index + 1}/${matchingClients.length} ${'─'.repeat(60)}`);
        console.log(`│ 🆔 ID Client      : ${client.clientId}`);
        console.log(`│ 👤 Nom            : ${client.firstName || 'N/A'} ${client.lastName || ''}`);
        console.log(`│ 📧 Email          : ${client.email || 'N/A'}`);
        console.log(`│ 📱 Téléphone      : ${client.phone || 'N/A'}`);
        console.log(`│ 🎫 Membership     : ${client.membership}`);
        console.log(`│ 📅 Date de début  : ${client.startDate ? client.startDate.toLocaleString('fr-FR') : 'N/A'}`);
        console.log(`│ ⚙️  Modifié par    : ${client.modifiedBy}`);
        console.log(`│ 📲 Créé depuis    : ${client.createdFrom || 'N/A'}`);
        console.log(`└${'─'.repeat(70)}`);
      });

      // Résumé formaté pour copier-coller
      console.log('\n\n' + '═'.repeat(80));
      console.log('📝 RÉSUMÉ FORMATÉ (facile à copier) :\n');
      console.log('Client ID | Nom | Email | Téléphone | Date de début');
      console.log('─'.repeat(80));
      
      matchingClients.forEach((client) => {
        const name = `${client.firstName || ''} ${client.lastName || ''}`.trim() || 'N/A';
        const date = client.startDate ? client.startDate.toLocaleDateString('fr-FR') : 'N/A';
        console.log(`${client.clientId} | ${name} | ${client.email || 'N/A'} | ${client.phone || 'N/A'} | ${date}`);
      });

      // Export JSON
      console.log('\n\n' + '═'.repeat(80));
      console.log('📄 FORMAT JSON :\n');
      console.log(JSON.stringify(matchingClients, null, 2));
    }

    console.log('\n\n' + '═'.repeat(80));
    console.log('✅ Script terminé avec succès - AUCUNE MODIFICATION effectuée');
    console.log('═'.repeat(80));

  } catch (error) {
    console.error('\n❌ Erreur lors de l\'exécution du script :', error);
    throw error;
  }
}

// Exécution du script
listSystemRegistrationClients()
  .then(() => {
    console.log('\n✅ Programme terminé');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Erreur fatale :', error);
    process.exit(1);
  });
