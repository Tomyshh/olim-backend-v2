import { createClient } from '@supabase/supabase-js';

const LOG_PREFIX = '[supabaseAuth]';

const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseKey =
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  '';

const authClient = supabaseUrl && supabaseKey
  ? createClient(supabaseUrl, supabaseKey, { auth: { autoRefreshToken: false, persistSession: false } })
  : null;

export interface SupabaseAuthResult {
  userId: string | null;
  created: boolean;
  error?: string;
}

export async function ensureSupabaseAuthUser(
  email: string,
  options?: { firebaseUid?: string }
): Promise<SupabaseAuthResult> {
  if (!authClient) {
    console.warn(LOG_PREFIX, 'Supabase auth client not configured');
    return { userId: null, created: false, error: 'not_configured' };
  }

  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail || !normalizedEmail.includes('@')) {
    return { userId: null, created: false, error: 'invalid_email' };
  }

  try {
    const { data: existingUsers } = await authClient.auth.admin.listUsers({
      page: 1,
      perPage: 1
    });

    const existingByEmail = existingUsers?.users?.find(
      (u) => u.email?.toLowerCase() === normalizedEmail
    );

    if (existingByEmail) {
      return { userId: existingByEmail.id, created: false };
    }

    const randomPassword = crypto.randomUUID() + crypto.randomUUID();

    const { data, error } = await authClient.auth.admin.createUser({
      email: normalizedEmail,
      password: randomPassword,
      email_confirm: true,
      user_metadata: {
        firebase_uid: options?.firebaseUid ?? null,
        migrated_from: 'firebase',
        migrated_at: new Date().toISOString()
      }
    });

    if (error) {
      if (error.message?.includes('already been registered') ||
          error.message?.includes('already exists')) {
        const { data: listData } = await authClient.auth.admin.listUsers({ page: 1, perPage: 50 });
        const found = listData?.users?.find(u => u.email?.toLowerCase() === normalizedEmail);
        if (found) {
          return { userId: found.id, created: false };
        }
      }
      console.error(LOG_PREFIX, 'createUser failed:', error.message);
      return { userId: null, created: false, error: error.message };
    }

    return { userId: data.user?.id ?? null, created: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(LOG_PREFIX, 'ensureSupabaseAuthUser threw:', message);
    return { userId: null, created: false, error: message };
  }
}
