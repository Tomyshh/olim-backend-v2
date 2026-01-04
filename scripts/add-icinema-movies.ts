import { initializeFirebase, getFirestore } from '../src/config/firebase.js';
import admin from 'firebase-admin';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Script pour ajouter les films à l'affiche et à venir dans la collection iCinema.
 *
 * IMPORTANT :
 * - La collection `iCinema` est une collection racine contenant des documents "film" (1 film = 1 doc).
 * - Ce script crée/merge des docs stables `cm-<slug>` pour les films récupérés sur CenturyMax.
 *
 * Sécurité :
 * - Ne touche qu'à `iCinema`.
 * - Supprime uniquement le champ `movies` si on détecte qu'il s'agit de l'ancien mauvais format (tableau injecté par erreur).
 */

type Status = 'now_playing' | 'coming_soon';

interface CenturyMovie {
  title: string;
  slug: string;
  url: string;
  status: Status;
}

const centuryMovies: CenturyMovie[] = [
  { title: 'Zootopie 2', slug: 'zootopie-2', url: 'https://centurymax-studios.com/zootopie-2/', status: 'now_playing' },
  {
    title: 'Avatar : de Feu et de Cendres',
    slug: 'avatar-fire-and-ash',
    url: 'https://centurymax-studios.com/avatar-fire-and-ash/',
    status: 'now_playing'
  },
  { title: 'Marsupilami', slug: 'marsupilami', url: 'https://centurymax-studios.com/marsupilami/', status: 'coming_soon' },
  {
    title: 'Vaiana Live Action',
    slug: 'vaiana-live-action',
    url: 'https://centurymax-studios.com/vaiana-live-action/',
    status: 'coming_soon'
  },
  { title: 'Toy Story 5', slug: 'toy-story-5', url: 'https://centurymax-studios.com/toy-story-5/', status: 'coming_soon' },
  {
    title: "Le diable s'habille en Prada 2",
    slug: 'le-diable-shabille-en-prada-2',
    url: 'https://centurymax-studios.com/le-diable-shabille-en-prada-2/',
    status: 'coming_soon'
  },
  {
    title: 'Les hauts de Hurlevent',
    slug: 'les-hauts-de-hurlevent',
    url: 'https://centurymax-studios.com/les-hauts-de-hurlevent/',
    status: 'coming_soon'
  },
  {
    title: 'Super Mario Galaxy',
    slug: 'super-mario-galaxy',
    url: 'https://centurymax-studios.com/super-mario-galaxy/',
    status: 'coming_soon'
  },
  { title: 'Michael', slug: 'michael', url: 'https://centurymax-studios.com/michael/', status: 'coming_soon' },
  { title: 'The Odyssey', slug: 'the-odyssey', url: 'https://centurymax-studios.com/the-odyssey/', status: 'coming_soon' }
];

function looksLikeOurWrongMoviesArray(movies: unknown): boolean {
  if (!Array.isArray(movies)) return false;
  const titles = new Set(
    movies
      .map((m: any) => (typeof m?.title === 'string' ? m.title : null))
      .filter((t: any) => typeof t === 'string')
  );
  const targetTitles = new Set(centuryMovies.map((m) => m.title));
  let hit = 0;
  for (const t of titles) {
    if (targetTitles.has(t)) hit++;
    if (hit >= 2) return true;
  }
  return false;
}

async function addICinemaMovies() {
  console.log("🎬 Upsert des films CenturyMax dans `iCinema` (1 film = 1 doc)\n");
  console.log('Source:', 'https://centurymax-studios.com/');
  console.log('─'.repeat(80));

  initializeFirebase();
  const db = getFirestore();
  const now = admin.firestore.Timestamp.now();

  // 1) Nettoyage ciblé
  console.log('\n🧹 Nettoyage: recherche d’un champ `movies` ajouté par erreur...');
  const scanSnap = await db.collection('iCinema').get();
  let cleaned = 0;
  for (const doc of scanSnap.docs) {
    const data = doc.data();
    if (looksLikeOurWrongMoviesArray((data as any).movies)) {
      await db.collection('iCinema').doc(doc.id).set(
        { movies: admin.firestore.FieldValue.delete(), updatedAt: now },
        { merge: true }
      );
      cleaned++;
      console.log(`   - ✅ Nettoyé (suppression champ movies) sur docId=${doc.id}`);
    }
  }
  if (cleaned === 0) console.log('   - OK: rien à nettoyer');

  // 2) Upsert des docs films
  console.log('\n📽️  Upsert des films :');
  let upserted = 0;
  for (const movie of centuryMovies) {
    const docId = `cm-${movie.slug}`;
    const payload: Record<string, any> = {
      title: movie.title,
      Langue: 'FR',
      isProjected: movie.status === 'now_playing',
      redirectionURL: movie.url,
      updatedAt: now
    };
    await db.collection('iCinema').doc(docId).set(payload, { merge: true });
    upserted++;
    console.log(`   - ✅ ${movie.title} -> docId=${docId}`);
  }

  console.log('\n' + '═'.repeat(80));
  console.log(`✅ Terminé. Films upsert: ${upserted}. Docs nettoyés: ${cleaned}.`);
  console.log('═'.repeat(80));
}

addICinemaMovies()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('\n❌ Erreur fatale :', error);
    process.exit(1);
  });

