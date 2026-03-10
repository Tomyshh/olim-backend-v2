import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { Client as PgClient } from 'pg';

interface SupabaseServiceConfig {
  user?: string;
  password?: string;
  password_base64?: string;
}

function loadDbClientConfig() {
  const cfgPath = path.resolve(process.cwd(), 'scripts/firebase-auth-migration/supabase-service.json');
  if (!fs.existsSync(cfgPath)) {
    throw new Error(`Fichier introuvable: ${cfgPath}`);
  }

  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as SupabaseServiceConfig;
  const password = cfg.password_base64?.startsWith('base64:')
    ? Buffer.from(cfg.password_base64.slice(7), 'base64').toString('utf8')
    : (cfg.password || '');
  const projectRef = (cfg.user || '').replace(/^postgres\./, '');
  if (!projectRef || !password) {
    throw new Error('Configuration Supabase Postgres invalide (projectRef/password).');
  }

  return {
    host: `db.${projectRef}.supabase.co`,
    port: 5432,
    database: 'postgres',
    user: 'postgres',
    password,
    ssl: { rejectUnauthorized: false }
  } as const;
}

const ENRICH_SQL = `
ALTER TABLE public.partners
  ADD COLUMN IF NOT EXISTS vip boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS categorie text,
  ADD COLUMN IF NOT EXISTS partner_type text,
  ADD COLUMN IF NOT EXISTS adresse text,
  ADD COLUMN IF NOT EXISTS waze text,
  ADD COLUMN IF NOT EXISTS keywords jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS subtitle jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS villes jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS langues jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS images jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS icon text,
  ADD COLUMN IF NOT EXISTS icon_vip text,
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE public.partners
  DROP CONSTRAINT IF EXISTS partners_firestore_id_key;
ALTER TABLE public.partners
  ADD CONSTRAINT partners_firestore_id_key UNIQUE (firestore_id);

CREATE INDEX IF NOT EXISTS idx_partners_vip ON public.partners (vip);
CREATE INDEX IF NOT EXISTS idx_partners_categorie ON public.partners (categorie);
CREATE INDEX IF NOT EXISTS idx_partners_partner_type ON public.partners (partner_type);

UPDATE public.partners
SET is_active = true
WHERE is_active IS NULL;

ALTER TABLE public.partners
  ALTER COLUMN is_active SET DEFAULT true;
ALTER TABLE public.partners
  ALTER COLUMN is_active SET NOT NULL;
`;

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const pg = new PgClient(loadDbClientConfig());

  try {
    await pg.connect();

    if (dryRun) {
      console.log('[dry-run] SQL enrichment not applied.');
    } else {
      await pg.query('BEGIN');
      await pg.query(ENRICH_SQL);
      await pg.query('COMMIT');
      console.log('✅ Table public.partners enrichie.');
    }

    const cols = await pg.query(
      `
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'partners'
      ORDER BY ordinal_position
      `
    );
    console.log('Colonnes partners:', cols.rows.map((r) => `${r.column_name}:${r.data_type}`).join(', '));
  } catch (error) {
    try {
      await pg.query('ROLLBACK');
    } catch {
      // ignore rollback errors
    }
    throw error;
  } finally {
    await pg.end();
  }
}

main().catch((e) => {
  console.error('❌ Enrich partners table failed:', e);
  process.exit(1);
});

