import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

// Si .env.local n'est pas chargé par défaut, on peut forcer le chargement
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
// Backend: préférer une clé service-role (pas de contraintes RLS), fallback anon si besoin
const supabaseKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  '';

if (!supabaseUrl || !supabaseKey) {
  console.warn('[supabase] Missing Supabase environment variables.');
}

if (supabaseKey && supabaseKey === process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
  console.warn('[supabase] Using ANON key for backend jobs. Prefer SUPABASE_SERVICE_ROLE_KEY to avoid RLS issues.');
}

export const supabase = createClient(supabaseUrl, supabaseKey);
