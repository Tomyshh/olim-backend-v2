import 'dotenv/config';
import admin from 'firebase-admin';
import { mkdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { initializeFirebase, getFirestore } from '../src/config/firebase.js';

/**
 * Inspecteur de schéma Firestore (LECTURE SEULE)
 * ------------------------------------------------
 * Objectif: parcourir la base Firestore collection par collection, document par document,
 * y compris les sous-collections, afin de déduire la structure globale (champs, types, relations).
 *
 * IMPORTANT:
 * - Ce script n'effectue AUCUNE écriture dans Firestore (lecture uniquement).
 * - Il peut être coûteux si la base est grande (beaucoup de lectures).
 *
 * Exécution (exemples):
 *   npx tsx scripts/inspect-firestore-schema.ts
 *   npx tsx scripts/inspect-firestore-schema.ts --outDir ./tmp/firestore-schema
 *   npx tsx scripts/inspect-firestore-schema.ts --maxDocsPerCollection 0 --maxDepth 10
 *   npx tsx scripts/inspect-firestore-schema.ts --emitSql true
 *
 * Options:
 * - --outDir <path>               (défaut: ./tmp/firestore-schema)
 * - --maxDocsPerCollection <n>    0 = illimité (défaut: 0)
 * - --pageSize <n>                taille des pages de lecture (défaut: 250)
 * - --maxDepth <n>                profondeur max sous-collections (défaut: 25)
 * - --skipSubcollections <true|false> ignore les sous-collections (défaut: false)
 * - --subcollectionDiscoveryDocs <n> nb de docs (par collection) utilisés pour découvrir/sonder les sous-collections (défaut: 50)
 * - --subcollectionMaxInstancesPerPath <n> nb max d'instances scannées par chemin normalisé de sous-collection (défaut: 50)
 * - --logEveryDocs <n>            log de progression toutes les N lectures doc (défaut: 500)
 * - --maxFieldDepth <n>           profondeur max d'analyse des maps/arrays (défaut: 20)
 * - --maxExamples <n>             nb max d'exemples par champ/type (défaut: 5)
 * - --emitSql <true|false>        génère aussi un .sql (Postgres/Supabase) (défaut: false)
 */

type JsonType =
  | 'null'
  | 'boolean'
  | 'number'
  | 'string'
  | 'timestamp'
  | 'geopoint'
  | 'reference'
  | 'bytes'
  | 'array'
  | 'map'
  | 'unknown';

type FieldStats = {
  path: string;
  totalSeen: number; // nombre de fois où le champ est présent (y compris null)
  nonNullSeen: number;
  types: Record<JsonType, number>;
  examples: Record<JsonType, unknown[]>;
};

type CollectionStats = {
  normalizedPath: string; // ex: Clients/{docId}/subscription
  observedPaths: Set<string>; // chemins de champs observés
  docsScanned: number;
  fields: Record<string, FieldStats>; // key=fieldPath
  maxDocumentNesting: number; // profondeur max rencontrée dans les champs
  sampleDocumentPaths: string[]; // quelques exemples de docs scannés
};

type Edge = {
  fromCollection: string; // normalized parent collection path
  toSubcollection: string; // subcollection name
  toCollection: string; // normalized child collection path
  depth: number; // profondeur dans l'arbre (0=root)
};

type Output = {
  generatedAt: string;
  firebaseProjectId?: string;
  totals: {
    collectionsDiscovered: number;
    collectionsScanned: number;
    documentsScanned: number;
    edgesDiscovered: number;
  };
  collections: Record<string, Omit<CollectionStats, 'observedPaths'>>;
  edges: Edge[];
};

function pickArg(name: string): string {
  const idx = process.argv.findIndex((x) => x === `--${name}`);
  if (idx >= 0) return String(process.argv[idx + 1] || '').trim();
  return '';
}

function pickNumber(name: string, fallback: number): number {
  const raw = pickArg(name);
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function pickBoolean(name: string, fallback: boolean): boolean {
  const raw = pickArg(name);
  if (!raw) return fallback;
  return raw === 'true' || raw === '1' || raw === 'yes';
}

function normalizeDocOrCollectionPath(path: string): string {
  // Firestore path segments: collection/doc/collection/doc...
  // On remplace chaque segment "docId" (index impair) par "{docId}".
  const parts = path.split('/').filter(Boolean);
  return parts
    .map((seg, idx) => (idx % 2 === 1 ? '{docId}' : seg))
    .join('/');
}

function ensureField(stats: CollectionStats, fieldPath: string, maxExamples: number): FieldStats {
  const existing = stats.fields[fieldPath];
  if (existing) return existing;
  const created: FieldStats = {
    path: fieldPath,
    totalSeen: 0,
    nonNullSeen: 0,
    types: {
      null: 0,
      boolean: 0,
      number: 0,
      string: 0,
      timestamp: 0,
      geopoint: 0,
      reference: 0,
      bytes: 0,
      array: 0,
      map: 0,
      unknown: 0
    },
    examples: {
      null: [],
      boolean: [],
      number: [],
      string: [],
      timestamp: [],
      geopoint: [],
      reference: [],
      bytes: [],
      array: [],
      map: [],
      unknown: []
    }
  };
  stats.fields[fieldPath] = created;
  stats.observedPaths.add(fieldPath);
  // pre-allocate nothing; but keep maxExamples in mind when pushing
  void maxExamples;
  return created;
}

function detectType(value: unknown): { t: JsonType; example: unknown } {
  if (value === null || value === undefined) return { t: 'null', example: null };
  if (typeof value === 'boolean') return { t: 'boolean', example: value };
  if (typeof value === 'number') return { t: 'number', example: value };
  if (typeof value === 'string') return { t: 'string', example: value.length > 200 ? `${value.slice(0, 200)}…` : value };

  // Firestore special types
  const TimestampCtor = (admin.firestore as any)?.Timestamp;
  if (typeof TimestampCtor === 'function' && value instanceof TimestampCtor) {
    return { t: 'timestamp', example: (value as admin.firestore.Timestamp).toDate().toISOString() };
  }

  const GeoPointCtor = (admin.firestore as any)?.GeoPoint;
  if (typeof GeoPointCtor === 'function' && value instanceof GeoPointCtor) {
    const gp = value as admin.firestore.GeoPoint;
    return { t: 'geopoint', example: { latitude: gp.latitude, longitude: gp.longitude } };
  }

  // DocumentReference n'est pas toujours exposé comme constructeur via firebase-admin
  const maybeRefPath = (value as any)?.path;
  const maybeRefId = (value as any)?.id;
  if (typeof maybeRefPath === 'string' && typeof maybeRefId === 'string') {
    return { t: 'reference', example: maybeRefPath };
  }

  // Bytes: selon les SDK, peut être Buffer/Uint8Array
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) {
    return { t: 'bytes', example: `bytes(${value.byteLength})` };
  }
  if (value instanceof Uint8Array) {
    return { t: 'bytes', example: `bytes(${value.byteLength})` };
  }

  if (Array.isArray(value)) return { t: 'array', example: value.length > 20 ? `array(len=${value.length})` : value };
  if (typeof value === 'object') return { t: 'map', example: value };
  return { t: 'unknown', example: String(value) };
}

function pushExample(field: FieldStats, t: JsonType, example: unknown, maxExamples: number): void {
  const arr = field.examples[t];
  if (!arr) return;
  if (arr.length >= maxExamples) return;
  // éviter trop de gros objets dans les exemples
  if (t === 'map') {
    arr.push('[map]');
    return;
  }
  if (t === 'array') {
    arr.push('[array]');
    return;
  }
  arr.push(example);
}

function analyzeValue(
  collection: CollectionStats,
  fieldPath: string,
  value: unknown,
  opts: { maxFieldDepth: number; maxExamples: number; depth: number }
): void {
  const field = ensureField(collection, fieldPath, opts.maxExamples);
  field.totalSeen += 1;

  const { t, example } = detectType(value);
  field.types[t] = (field.types[t] || 0) + 1;
  if (t !== 'null') field.nonNullSeen += 1;
  pushExample(field, t, example, opts.maxExamples);

  collection.maxDocumentNesting = Math.max(collection.maxDocumentNesting, opts.depth);

  if (opts.depth >= opts.maxFieldDepth) return;

  if (t === 'map' && value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      analyzeValue(collection, `${fieldPath}.${k}`, v, { ...opts, depth: opts.depth + 1 });
    }
    return;
  }

  if (t === 'array' && Array.isArray(value)) {
    // On enregistre les types d'éléments sous le chemin "fieldPath[]"
    const elementPath = `${fieldPath}[]`;
    for (const el of value) {
      analyzeValue(collection, elementPath, el, { ...opts, depth: opts.depth + 1 });
    }
  }
}

async function scanCollectionRef(params: {
  db: FirebaseFirestore.Firestore;
  collectionRef: FirebaseFirestore.CollectionReference;
  collectionPath: string; // actual path, ex: Clients/abc/subscription
  normalizedCollectionPath: string; // ex: Clients/{docId}/subscription
  depth: number;
  maxDepth: number;
  skipSubcollections: boolean;
  subcollectionDiscoveryDocs: number;
  subcollectionMaxInstancesPerPath: number;
  logEveryDocs: number;
  maxDocsPerCollection: number; // 0=illimité
  pageSize: number;
  maxFieldDepth: number;
  maxExamples: number;
  collections: Map<string, CollectionStats>;
  edges: Map<string, Edge>;
  scannedSubcollectionInstancesByPath: Map<string, number>;
  totals: { documentsScanned: number };
}): Promise<void> {
  const {
    collectionRef,
    collectionPath,
    normalizedCollectionPath,
    depth,
    maxDepth,
    skipSubcollections,
    subcollectionDiscoveryDocs,
    subcollectionMaxInstancesPerPath,
    logEveryDocs,
    maxDocsPerCollection,
    pageSize,
    maxFieldDepth,
    maxExamples,
    collections,
    edges,
    scannedSubcollectionInstancesByPath,
    totals
  } = params;

  let stats = collections.get(normalizedCollectionPath);
  if (!stats) {
    stats = {
      normalizedPath: normalizedCollectionPath,
      observedPaths: new Set<string>(),
      docsScanned: 0,
      fields: {},
      maxDocumentNesting: 0,
      sampleDocumentPaths: []
    };
    collections.set(normalizedCollectionPath, stats);
  }

  const docIdField = admin.firestore.FieldPath.documentId();
  let lastDoc: FirebaseFirestore.QueryDocumentSnapshot | null = null;
  let stop = false;

  while (!stop) {
    let q: FirebaseFirestore.Query = collectionRef.orderBy(docIdField).limit(pageSize);
    if (lastDoc) q = q.startAfter(lastDoc);

    const snap = await q.get();
    if (snap.empty) break;

    for (const doc of snap.docs) {
      // Respect maxDocsPerCollection (global par chemin normalisé)
      if (maxDocsPerCollection > 0 && stats.docsScanned >= maxDocsPerCollection) {
        stop = true;
        break;
      }

      stats.docsScanned += 1;
      totals.documentsScanned += 1;
      if (stats.sampleDocumentPaths.length < 10) stats.sampleDocumentPaths.push(doc.ref.path);

      if (logEveryDocs > 0 && totals.documentsScanned % logEveryDocs === 0) {
        console.log(`   … progression: ${totals.documentsScanned} documents lus (dernier: ${doc.ref.path})`);
      }

      const data = doc.data() as Record<string, unknown>;
      for (const [k, v] of Object.entries(data)) {
        analyzeValue(stats, k, v, { maxFieldDepth, maxExamples, depth: 1 });
      }

      const allowDiscover = subcollectionDiscoveryDocs <= 0 || stats.docsScanned <= subcollectionDiscoveryDocs;
      if (!skipSubcollections && allowDiscover && depth < maxDepth) {
        // Parcours des sous-collections de ce document
        const subcols = await doc.ref.listCollections();
        for (const sub of subcols) {
          const subPath = sub.path; // ex: Clients/abc/subscription
          const normalizedSubPath = normalizeDocOrCollectionPath(subPath);
          const edgeKey = `${normalizedCollectionPath} -> ${sub.id} -> ${normalizedSubPath}`;
          if (!edges.has(edgeKey)) {
            edges.set(edgeKey, {
              fromCollection: normalizedCollectionPath,
              toSubcollection: sub.id,
              toCollection: normalizedSubPath,
              depth
            });
          }

          const already = scannedSubcollectionInstancesByPath.get(normalizedSubPath) || 0;
          if (subcollectionMaxInstancesPerPath > 0 && already >= subcollectionMaxInstancesPerPath) {
            continue;
          }
          scannedSubcollectionInstancesByPath.set(normalizedSubPath, already + 1);

          await scanCollectionRef({
            ...params,
            collectionRef: sub,
            collectionPath: subPath,
            normalizedCollectionPath: normalizedSubPath,
            depth: depth + 1
          });
        }
      }
    }

    lastDoc = snap.docs[snap.docs.length - 1] || null;
    if (snap.size < pageSize) break;
  }

  void collectionPath; // conservé pour debug futur si besoin
}

function toPostgresSql(output: Output): string {
  // SQL “lecture” côté DB relationnelle: on insère juste un snapshot d'inférence.
  const payload = JSON.stringify(output).replaceAll("'", "''");
  return [
    '-- Généré par scripts/inspect-firestore-schema.ts',
    '-- Stocke la structure Firestore inférée (snapshot JSON)',
    'BEGIN;',
    'CREATE TABLE IF NOT EXISTS firestore_inferred_schema (',
    '  id BIGSERIAL PRIMARY KEY,',
    '  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),',
    '  firebase_project_id TEXT,',
    '  payload JSONB NOT NULL',
    ');',
    `INSERT INTO firestore_inferred_schema (firebase_project_id, payload) VALUES (${output.firebaseProjectId ? `'${output.firebaseProjectId.replaceAll("'", "''")}'` : 'NULL'}, '${payload}'::jsonb);`,
    'COMMIT;'
  ].join('\n');
}

async function main(): Promise<void> {
  const outDir = pickArg('outDir') || './tmp/firestore-schema';
  const maxDocsPerCollection = pickNumber('maxDocsPerCollection', 0);
  const pageSize = pickNumber('pageSize', 250);
  const maxDepth = pickNumber('maxDepth', 25);
  const skipSubcollections = pickBoolean('skipSubcollections', false);
  const subcollectionDiscoveryDocs = pickNumber('subcollectionDiscoveryDocs', 50);
  const subcollectionMaxInstancesPerPath = pickNumber('subcollectionMaxInstancesPerPath', 50);
  const logEveryDocs = pickNumber('logEveryDocs', 500);
  const maxFieldDepth = pickNumber('maxFieldDepth', 20);
  const maxExamples = pickNumber('maxExamples', 5);
  const emitSql = pickBoolean('emitSql', false);

  console.log('🔎 Inspection Firestore (LECTURE SEULE)');
  console.log('Options:', {
    outDir,
    maxDocsPerCollection,
    pageSize,
    maxDepth,
    skipSubcollections,
    subcollectionDiscoveryDocs,
    subcollectionMaxInstancesPerPath,
    logEveryDocs,
    maxFieldDepth,
    maxExamples,
    emitSql
  });

  initializeFirebase();
  const db = getFirestore();

  const rootCollections = await db.listCollections();
  console.log(`📚 Collections racine détectées: ${rootCollections.length}`);

  const collections = new Map<string, CollectionStats>();
  const edges = new Map<string, Edge>();
  const scannedSubcollectionInstancesByPath = new Map<string, number>();
  const totals = { documentsScanned: 0 };

  for (const col of rootCollections) {
    const normalized = normalizeDocOrCollectionPath(col.path);
    console.log(`\n➡️  Scan collection: ${col.path} (normalisé: ${normalized})`);
    await scanCollectionRef({
      db,
      collectionRef: col,
      collectionPath: col.path,
      normalizedCollectionPath: normalized,
      depth: 0,
      maxDepth,
      skipSubcollections,
      subcollectionDiscoveryDocs,
      subcollectionMaxInstancesPerPath,
      logEveryDocs,
      maxDocsPerCollection,
      pageSize,
      maxFieldDepth,
      maxExamples,
      collections,
      edges,
      scannedSubcollectionInstancesByPath,
      totals
    });
  }

  const output: Output = {
    generatedAt: new Date().toISOString(),
    firebaseProjectId: admin.app().options?.projectId,
    totals: {
      collectionsDiscovered: rootCollections.length,
      collectionsScanned: collections.size,
      documentsScanned: totals.documentsScanned,
      edgesDiscovered: edges.size
    },
    collections: {},
    edges: [...edges.values()].sort((a, b) => a.toCollection.localeCompare(b.toCollection))
  };

  for (const [k, v] of collections.entries()) {
    output.collections[k] = {
      normalizedPath: v.normalizedPath,
      docsScanned: v.docsScanned,
      fields: v.fields,
      maxDocumentNesting: v.maxDocumentNesting,
      sampleDocumentPaths: v.sampleDocumentPaths
    };
  }

  const absOutDir = resolve(process.cwd(), outDir);
  mkdirSync(absOutDir, { recursive: true });

  const jsonPath = resolve(absOutDir, `firestore-schema-${Date.now()}.json`);
  writeFileSync(jsonPath, JSON.stringify(output, null, 2), 'utf8');
  console.log(`\n✅ JSON écrit: ${jsonPath}`);

  if (emitSql) {
    const sqlPath = resolve(absOutDir, `firestore-schema-${Date.now()}.sql`);
    writeFileSync(sqlPath, toPostgresSql(output), 'utf8');
    console.log(`✅ SQL écrit: ${sqlPath}`);
  }

  console.log('\nRésumé:', output.totals);
  console.log('✅ Terminé (aucune modification Firestore).');
}

main().catch((e) => {
  console.error('❌ Erreur:', e);
  process.exit(1);
});

