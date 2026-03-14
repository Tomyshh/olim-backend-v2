import { supabase } from './supabase.service.js';

const LOG_PREFIX = '[supabaseFirstWrite]';

async function logFirestoreFailure(
  table: string,
  operation: string,
  payload: unknown,
  err: unknown
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  try {
    await supabase.from('dual_write_failures').insert({
      target_table: table,
      operation,
      direction: 'to_firestore',
      payload: typeof payload === 'object' ? payload : { value: payload },
      error_message: message,
      error_stack: stack ?? null,
    });
  } catch (logErr) {
    console.error(LOG_PREFIX, 'Failed to log Firestore sync failure', logErr);
  }
}

/**
 * Write to Supabase first, then sync to Firestore in best-effort.
 * Firestore failures are logged but never block the response.
 */
export async function supabaseFirstWrite<T>(params: {
  supabaseWrite: () => Promise<T>;
  firestoreWrite: () => Promise<void>;
  context: string;
  table: string;
}): Promise<T> {
  const { supabaseWrite, firestoreWrite, context, table } = params;

  const result = await supabaseWrite();

  firestoreWrite().catch(async (err) => {
    console.warn(LOG_PREFIX, `[${context}] Firestore sync failed (best-effort)`, err);
    await logFirestoreFailure(table, context, {}, err);
  });

  return result;
}

/**
 * Supabase insert with Firestore best-effort sync.
 */
export async function supabaseInsertThenFirestore(params: {
  table: string;
  supabaseData: Record<string, any>;
  firestoreWrite: () => Promise<void>;
  context: string;
}): Promise<{ data: any; error: any }> {
  const { table, supabaseData, firestoreWrite, context } = params;

  for (const k of Object.keys(supabaseData)) {
    if (supabaseData[k] === undefined) delete supabaseData[k];
  }

  const result = await supabase.from(table).insert(supabaseData).select().maybeSingle();

  if (result.error) {
    console.error(LOG_PREFIX, `[${context}] Supabase insert failed on ${table}:`, result.error.message);
    throw result.error;
  }

  firestoreWrite().catch(async (err) => {
    console.warn(LOG_PREFIX, `[${context}] Firestore sync failed (best-effort)`, err);
    await logFirestoreFailure(table, context, supabaseData, err);
  });

  return result;
}

/**
 * Supabase upsert with Firestore best-effort sync.
 */
export async function supabaseUpsertThenFirestore(params: {
  table: string;
  supabaseData: Record<string, any>;
  onConflict: string;
  firestoreWrite: () => Promise<void>;
  context: string;
}): Promise<void> {
  const { table, supabaseData, onConflict, firestoreWrite, context } = params;

  for (const k of Object.keys(supabaseData)) {
    if (supabaseData[k] === undefined) delete supabaseData[k];
  }

  const { error } = await supabase.from(table).upsert(supabaseData, { onConflict });

  if (error) {
    console.error(LOG_PREFIX, `[${context}] Supabase upsert failed on ${table}:`, error.message);
    throw error;
  }

  firestoreWrite().catch(async (err) => {
    console.warn(LOG_PREFIX, `[${context}] Firestore sync failed (best-effort)`, err);
    await logFirestoreFailure(table, context, supabaseData, err);
  });
}

/**
 * Supabase update with Firestore best-effort sync.
 */
export async function supabaseUpdateThenFirestore(params: {
  table: string;
  supabaseData: Record<string, any>;
  matchColumn: string;
  matchValue: unknown;
  firestoreWrite: () => Promise<void>;
  context: string;
}): Promise<void> {
  const { table, supabaseData, matchColumn, matchValue, firestoreWrite, context } = params;

  for (const k of Object.keys(supabaseData)) {
    if (supabaseData[k] === undefined) delete supabaseData[k];
  }

  const { error } = await supabase.from(table).update(supabaseData).eq(matchColumn, matchValue);

  if (error) {
    console.error(LOG_PREFIX, `[${context}] Supabase update failed on ${table}:`, error.message);
    throw error;
  }

  firestoreWrite().catch(async (err) => {
    console.warn(LOG_PREFIX, `[${context}] Firestore sync failed (best-effort)`, err);
    await logFirestoreFailure(table, context, supabaseData, err);
  });
}

/**
 * Supabase delete with Firestore best-effort sync.
 */
export async function supabaseDeleteThenFirestore(params: {
  table: string;
  matchColumn: string;
  matchValue: unknown;
  firestoreWrite: () => Promise<void>;
  context: string;
}): Promise<void> {
  const { table, matchColumn, matchValue, firestoreWrite, context } = params;

  const { error } = await supabase.from(table).delete().eq(matchColumn, matchValue);

  if (error) {
    console.error(LOG_PREFIX, `[${context}] Supabase delete failed on ${table}:`, error.message);
    throw error;
  }

  firestoreWrite().catch(async (err) => {
    console.warn(LOG_PREFIX, `[${context}] Firestore sync failed (best-effort)`, err);
    await logFirestoreFailure(table, context, { matchColumn, matchValue }, err);
  });
}
