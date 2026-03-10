import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { initializeFirebase, getFirestore } from '../src/config/firebase.js';

type PrimitiveType =
  | 'null'
  | 'boolean'
  | 'number'
  | 'string'
  | 'timestamp'
  | 'array'
  | 'map'
  | 'unknown';

interface FieldStats {
  totalSeen: number;
  types: Record<PrimitiveType, number>;
}

interface Report {
  startedAt: string;
  completedAt?: string;
  dryRun: boolean;
  onlyVip: boolean;
  batchSize: number;
  totalDocsScanned: number;
  totalMigrated: number;
  totalSkipped: number;
  errors: Array<{ firestoreId: string; error: string }>;
  detectedFields: Record<string, FieldStats>;
  samplePaths: string[];
}

function pickArg(name: string): string {
  const idx = process.argv.findIndex((x) => x === `--${name}`);
  if (idx >= 0) return String(process.argv[idx + 1] || '').trim();
  return '';
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function asString(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'string') {
    const s = v.trim();
    return s.length ? s : null;
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => asString(item))
      .filter((item): item is string => Boolean(item));
  }
  const single = asString(value);
  return single ? [single] : [];
}

function firstString(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const s = asString(item);
      if (s) return s;
    }
    return null;
  }
  return asString(value);
}

function toBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase();
    return s === 'true' || s === '1' || s === 'yes' || s === 'vip';
  }
  return false;
}

function toJsonSafe(value: unknown): unknown {
  if (value === undefined) return null;
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  if (isTimestampLike(value)) {
    try {
      return (value as { toDate: () => Date }).toDate().toISOString();
    } catch {
      return null;
    }
  }
  if (Array.isArray(value)) {
    return value.map((item) => toJsonSafe(item));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue;
      out[k] = toJsonSafe(v);
    }
    return out;
  }
  return String(value);
}

function isTimestampLike(v: unknown): boolean {
  return !!v && typeof v === 'object' && 'toDate' in (v as Record<string, unknown>);
}

function inferType(v: unknown): PrimitiveType {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'string') return 'string';
  if (Array.isArray(v)) return 'array';
  if (isTimestampLike(v) || v instanceof Date) return 'timestamp';
  if (typeof v === 'object') return 'map';
  return 'unknown';
}

function createEmptyTypeCounter(): Record<PrimitiveType, number> {
  return {
    null: 0,
    boolean: 0,
    number: 0,
    string: 0,
    timestamp: 0,
    array: 0,
    map: 0,
    unknown: 0
  };
}

function recordField(report: Report, fieldPath: string, value: unknown): void {
  const stats = report.detectedFields[fieldPath] || {
    totalSeen: 0,
    types: createEmptyTypeCounter()
  };
  const t = inferType(value);
  stats.totalSeen += 1;
  stats.types[t] += 1;
  report.detectedFields[fieldPath] = stats;
}

function analyzeObject(report: Report, obj: Record<string, unknown>, prefix = ''): void {
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    recordField(report, path, v);
    if (Array.isArray(v)) {
      for (const item of v) {
        recordField(report, `${path}[]`, item);
      }
    } else if (v && typeof v === 'object' && !isTimestampLike(v) && !(v instanceof Date)) {
      analyzeObject(report, v as Record<string, unknown>, path);
    }
  }
}

function getSupabaseEnv(): { url: string; key: string } {
  if (process.env.NODE_ENV !== 'production') {
    const localCandidates = [
      resolve(process.cwd(), '.env.local'),
      resolve(process.cwd(), '../olim_service/.env.local')
    ];
    for (const envPath of localCandidates) {
      dotenv.config({ path: envPath, override: false });
    }
  }

  const url =
    process.env.SUPABASE_URL ||
    process.env.EXPO_PUBLIC_SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    '';

  const key =
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_KEY ||
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    '';

  return { url, key };
}

function toPartnerRow(firestoreId: string, data: Record<string, unknown>): Record<string, unknown> {
  const title =
    asString(data.title) ||
    asString(data.Title) ||
    asString(data.name) ||
    asString(data.nom) ||
    'Partenaire';

  const description =
    asString(data.description) ||
    asString(data.Description) ||
    asString(data.desc) ||
    '';

  const vipSentence =
    asString(data.vip_sentence) ||
    asString(data.vipSentence) ||
    asString(data.VIPsentence) ||
    firstString(data.subtitle) ||
    '';

  const imagesRaw = (data.Images ?? data.images ?? data.offersImages) as unknown;
  const images = toJsonSafe(imagesRaw);

  const subtitle = toStringArray(data.subtitle);
  const keywords = toStringArray(data.keywords);
  const langues = toStringArray(data.langues ?? data.languages);
  const villes = toStringArray(data.villes ?? data.cities);
  const vip = toBoolean(data.VIP ?? data.isVIP ?? data.isVip);
  const isActiveRaw = data.isActive ?? data.is_active ?? data.active;
  const isActive = isActiveRaw == null ? true : toBoolean(isActiveRaw);

  const metadata = toJsonSafe(data);

  return {
    firestore_id: firestoreId,
    title,
    description,
    vip_sentence: vipSentence,
    vip,
    is_vip: vip,
    is_active: isActive,
    category: asString(data.categorie ?? data.category),
    categorie: asString(data.categorie ?? data.category),
    address: asString(data.adresse ?? data.address),
    partner_type: asString(data.partnerType ?? data.type),
    adresse: asString(data.adresse ?? data.address),
    waze: asString(data.waze),
    keywords,
    subtitle,
    villes,
    langues,
    images,
    icon:
      asString(data.icon) ||
      asString((data.Images as Record<string, unknown> | undefined)?.logo) ||
      null,
    icon_vip: asString(data.iconVIP ?? data.icon_vip),
    metadata,
    updated_at: new Date().toISOString()
  };
}

async function main(): Promise<void> {
  const dryRun = hasFlag('dry-run');
  const onlyVip = hasFlag('only-vip');
  const batchSize = Number(pickArg('batch-size') || 200);

  const report: Report = {
    startedAt: new Date().toISOString(),
    dryRun,
    onlyVip,
    batchSize: Number.isFinite(batchSize) && batchSize > 0 ? batchSize : 200,
    totalDocsScanned: 0,
    totalMigrated: 0,
    totalSkipped: 0,
    errors: [],
    detectedFields: {},
    samplePaths: []
  };

  const { url, key } = getSupabaseEnv();
  if (!url || !key) {
    console.error('Missing Supabase env (SUPABASE_URL + service key).');
    process.exit(1);
  }

  const supabase = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  initializeFirebase();
  const db = getFirestore();

  let lastDoc: FirebaseFirestore.QueryDocumentSnapshot | null = null;

  while (true) {
    let q: FirebaseFirestore.Query = db
      .collection('Partenaires')
      .orderBy('__name__')
      .limit(report.batchSize);

    if (lastDoc) {
      q = q.startAfter(lastDoc);
    }

    const snap = await q.get();
    if (snap.empty) break;

    for (const doc of snap.docs) {
      report.totalDocsScanned += 1;
      if (report.samplePaths.length < 10) {
        report.samplePaths.push(doc.ref.path);
      }

      const data = (doc.data() || {}) as Record<string, unknown>;
      analyzeObject(report, data);

      const isVip = data.VIP === true || data.isVIP === true || data.isVip === true;
      if (onlyVip && !isVip) {
        report.totalSkipped += 1;
        continue;
      }

      const row = toPartnerRow(doc.id, data);

      if (dryRun) {
        report.totalMigrated += 1;
        continue;
      }

      const { error } = await supabase
        .from('partners')
        .upsert(row, { onConflict: 'firestore_id' });

      if (error) {
        report.errors.push({ firestoreId: doc.id, error: error.message });
      } else {
        report.totalMigrated += 1;
      }
    }

    lastDoc = snap.docs[snap.docs.length - 1] || null;
    if (snap.size < report.batchSize) break;
  }

  report.completedAt = new Date().toISOString();

  const outDir = resolve(process.cwd(), 'tmp');
  mkdirSync(outDir, { recursive: true });
  const reportPath = resolve(outDir, `partners-migration-report-${Date.now()}.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');

  console.log('\n========== PARTNERS MIGRATION ==========');
  console.log(`Scanned: ${report.totalDocsScanned}`);
  console.log(`Migrated: ${report.totalMigrated}`);
  console.log(`Skipped: ${report.totalSkipped}`);
  console.log(`Errors: ${report.errors.length}`);
  console.log(`Dry run: ${report.dryRun}`);
  console.log(`Only VIP: ${report.onlyVip}`);
  console.log(`Report: ${reportPath}`);
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});

