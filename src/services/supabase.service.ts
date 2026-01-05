import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

// Si .env.local n'est pas chargé par défaut, on peut forcer le chargement
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn('[supabase] Missing Supabase environment variables.');
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
