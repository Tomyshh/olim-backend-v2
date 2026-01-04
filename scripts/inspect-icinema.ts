import { initializeFirebase, getFirestore } from '../src/config/firebase.js';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Script READ-ONLY pour inspecter la structure des documents de la collection Firestore `iCinema`.
 * Ne modifie rien.
 */
async function inspectICinema() {
  console.log('🔎 Inspection de la collection Firestore `iCinema` (READ-ONLY)\n');

  initializeFirebase();
  const db = getFirestore();

  const snap = await db.collection('iCinema').limit(10).get();

  console.log(`📦 Nombre de docs retournés (limit 10): ${snap.size}\n`);
  if (snap.empty) {
    console.log('❌ Collection `iCinema` vide ou inaccessible.');
    return;
  }

  const first = snap.docs[0]!;
  const data = first.data();

  console.log(`🧾 Exemple docId: ${first.id}`);
  console.log(`🔑 Champs (top-level): ${Object.keys(data).sort().join(', ') || '(aucun champ)'}`);

  // Afficher un extrait lisible (sans tout spammer)
  const preview: Record<string, unknown> = {};
  for (const k of Object.keys(data)) {
    const v = (data as any)[k];
    // tronque les très grosses chaînes
    if (typeof v === 'string' && v.length > 180) preview[k] = `${v.slice(0, 180)}…`;
    else preview[k] = v;
  }

  console.log('\n🧪 Aperçu (doc complet, chaînes tronquées si besoin):');
  console.log(JSON.stringify(preview, null, 2));

  console.log('\n✅ Fin inspection (aucune écriture effectuée).');
}

inspectICinema()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('❌ Erreur inspection iCinema:', e);
    process.exit(1);
  });


