import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

// Dev local: on charge .env.local (Render/Prod utilise des env vars)
import dotenv from 'dotenv';
import path from 'path';
if (process.env.NODE_ENV !== 'production') {
  const localCandidates = [
    path.resolve(process.cwd(), '.env.local'),
    path.resolve(process.cwd(), '../olim_service/.env.local')
  ];
  for (const envPath of localCandidates) {
    dotenv.config({ path: envPath, override: false });
  }
}

const supabaseUrl =
  process.env.SUPABASE_URL ||
  process.env.EXPO_PUBLIC_SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  '';
// Backend: préférer une clé service-role (pas de contraintes RLS), fallback anon si besoin
const supabaseKey =
  // Render (prod) - variable demandée côté infra
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ||
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
