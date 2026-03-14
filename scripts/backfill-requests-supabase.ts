import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.join(process.cwd(), '.env.local'), override: true });
dotenv.config({ path: path.join(process.cwd(), '.env') });

import { initializeFirebase, getFirestore } from '../src/config/firebase.js';
import { createClient } from '@supabase/supabase-js';

/**
 * backfill-requests-supabase.ts
 *
 * Re-reads ALL Firestore request documents (Clients/{uid}/Requests) and updates
 * every Supabase `requests` row with complete data from Firestore, filling in
 * columns that were not mapped during the initial migration.
 *
 * 100% READ-ONLY on Firestore.  Supabase receives UPDATE only (no INSERT).
 *
 * Usage:
 *   npx tsx scripts/backfill-requests-supabase.ts                       # full backfill
 *   npx tsx scripts/backfill-requests-supabase.ts --dry-run              # preview only
 *   npx tsx scripts/backfill-requests-supabase.ts --uid <firebase_uid>   # single client
 *   npx tsx scripts/backfill-requests-supabase.ts --uid <uid> --debug    # show mapped data
 *   npx tsx scripts/backfill-requests-supabase.ts --discover             # field discovery
 */

// ---------------------------------------------------------------------------
// Supabase init
// ---------------------------------------------------------------------------
const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
if (!supabaseUrl || !supabaseKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SECRET_KEY');
  process.exit(1);
}
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ---------------------------------------------------------------------------
// CLI helpers
// ---------------------------------------------------------------------------
const hasFlag = (name: string) => process.argv.includes(`--${name}`);
function pickArg(name: string): string {
  const idx = process.argv.findIndex((x) => x === `--${name}`);
  if (idx >= 0) return String(process.argv[idx + 1] || '').trim();
  return '';
}

// ---------------------------------------------------------------------------
// Value helpers
// ---------------------------------------------------------------------------
function toIso(v: unknown): string | null {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object' && v !== null && 'toDate' in (v as any)) {
    try { return (v as any).toDate().toISOString(); } catch { return null; }
  }
  if (typeof v === 'object' && v !== null && '_seconds' in (v as any)) {
    try { return new Date((v as any)._seconds * 1000).toISOString(); } catch { return null; }
  }
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return null;
    const dmy = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/);
    if (dmy) {
      const [, dd, mm, yyyy] = dmy;
      return `${yyyy}-${mm!.padStart(2, '0')}-${dd!.padStart(2, '0')}T00:00:00.000Z`;
    }
    return s;
  }
  if (typeof v === 'number') return new Date(v).toISOString();
  return null;
}

function pickStr(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') { const s = v.trim(); return s || null; }
  if (typeof v === 'number') return String(v);
  return null;
}

function pickBool(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  return null;
}

function pickInt(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v);
  return null;
}

function pickArray(v: unknown): any[] | null {
  if (Array.isArray(v) && v.length > 0) return v;
  return null;
}

// ---------------------------------------------------------------------------
// Caches: conseillers (name → uuid) and clients (firebase_uid → uuid)
// ---------------------------------------------------------------------------
const conseillerCache = new Map<string, string>();
const clientCache = new Map<string, string>();

async function loadConseillerCache(): Promise<void> {
  let offset = 0;
  while (true) {
    const { data } = await supabase
      .from('conseillers')
      .select('id, name')
      .range(offset, offset + 999);
    if (!data?.length) break;
    for (const c of data) {
      if (c.name) {
        conseillerCache.set(c.name.trim().toLowerCase(), c.id);
      }
    }
    if (data.length < 1000) break;
    offset += 1000;
  }
  console.log(`  Conseillers cache: ${conseillerCache.size} entries`);
}

async function loadClientCache(): Promise<void> {
  let offset = 0;
  while (true) {
    const { data } = await supabase
      .from('clients')
      .select('id, firebase_uid')
      .range(offset, offset + 999);
    if (!data?.length) break;
    for (const c of data) {
      if (c.firebase_uid) clientCache.set(c.firebase_uid, c.id);
    }
    if (data.length < 1000) break;
    offset += 1000;
  }
  console.log(`  Clients cache: ${clientCache.size} entries`);
}

function resolveConseillerId(assignedTo: string | null): string | null {
  if (!assignedTo) return null;
  return conseillerCache.get(assignedTo.trim().toLowerCase()) ?? null;
}

function resolveClientId(uid: string): string | null {
  return clientCache.get(uid) ?? null;
}

// ---------------------------------------------------------------------------
// Complete Firestore → Supabase mapping for a single request
// ---------------------------------------------------------------------------
function mapFullRequest(
  uid: string,
  requestId: string,
  fs: Record<string, any>,
): Record<string, any> {
  const assignedTo = pickStr(fs['Assigned to']);
  const conseillerId = resolveConseillerId(assignedTo);
  const clientId = resolveClientId(uid);

  const responseFiles = pickArray(fs['[Response] Attached Files']) ?? pickArray(fs['Response urls']);
  const ratingTags = pickArray(fs['Rating Tags']);

  const hasRdvData = !!(
    pickStr(fs['Date de rdv']) ||
    pickStr(fs['Lieux du rdv']) ||
    pickStr(fs['RDV Name'])
  );

  const formData = (fs['Form Data'] && typeof fs['Form Data'] === 'object')
    ? fs['Form Data']
    : null;

  const row: Record<string, any> = {
    firebase_request_id: requestId,
    user_id: uid,
    client_id: clientId,

    // Request identity
    request_type: pickStr(fs['Request Type']),
    request_category: pickStr(fs['Request Category']),
    request_sub_category: pickStr(fs['Request Sub-Category']),
    request_ref: pickStr(fs['Request Ref']),
    category_id: pickStr(fs['Category ID']),
    sub_category_id: pickStr(fs['SubCategory ID']),
    linked_request_id: pickStr(fs.linkedRequest),
    request_description: pickStr(fs.Description),

    // Client info on the request
    first_name: pickStr(fs['First Name']),
    last_name: pickStr(fs['Last Name']),
    email: pickStr(fs.Email),
    phone: pickStr(fs.Phone),
    membership_type: pickStr(fs['Membership Type']) ?? pickStr(fs.Membership),
    contact: pickStr(fs.Contact),
    location: pickStr(fs.Location),

    // Form data
    form_data: formData,

    // Tags & files
    tags: pickArray(fs.Tags),
    uploaded_files: pickArray(fs['Uploaded Files']),
    file_count: Array.isArray(fs['Uploaded Files']) ? fs['Uploaded Files'].length : null,
    available_days: pickArray(fs['Available Days']),
    available_hours: pickArray(fs['Available Hours']),
    rating_tags: ratingTags,
    missing_fields: pickArray(fs['Missing Fields']),
    has_missing_fields: pickBool(fs['Has Missing Fields']),

    // Status & flags
    status: pickStr(fs.Status),
    priority: pickInt(fs.Priority),
    difficulty: pickInt(fs.Difficulty),
    is_opened: pickBool(fs.isRequestOpened),
    success: pickBool(fs.success),
    is_pending: pickBool(fs.isPending),
    waiting_info_from_client: pickBool(fs.WaitingInfoFromClient),

    // Assignment
    assigned_to: assignedTo,
    assigned_to_conseiller_id: conseillerId,

    // Response
    response_text: pickStr(fs['Support Response']),
    response_date: toIso(fs['Support Response Date']),
    response_files: responseFiles,
    response_comment: pickStr(fs['Support Comment Response']),

    // RDV
    is_rdv: hasRdvData ? true : null,
    rdv_location: pickStr(fs['Lieux du rdv']),
    rdv_date: pickStr(fs['Date de rdv']),
    rdv_hours: pickStr(fs['Heure du rdv']),
    rdv_name: pickStr(fs['RDV Name']),
    is_rdv_over: pickBool(fs.isRdvOver),
    rdv_not_found: pickBool(fs.RdvNotFound),

    // Rating
    rating: pickInt(fs.Rating) ?? pickInt(fs.rating),
    client_comment: pickStr(fs['Client comment']) ?? pickStr(fs.ratingComment),

    // Waiting & additional
    waiting_time: pickStr(fs['Temps d\'attente']),
    additional_information: pickStr(fs['Additional information']),

    // Source & platform
    source: pickStr(fs.source),
    platform: pickStr(fs.Platform),
    app_version: pickStr(fs.Version),
    created_by: pickStr(fs.createdBy) ?? pickStr(fs['Created By']),

    // Dates
    request_date: toIso(fs['Request Date']),
    in_progress_date: toIso(fs.progressingDate) ?? toIso(fs['In Progress Date']),
    closing_date: toIso(fs.closingDate),
    created_at: toIso(fs['Created At']) ?? toIso(fs.createdAt),
    updated_at: new Date().toISOString(),
    sync_source: 'backfill',
    sync_date: new Date().toISOString(),

    // Metadata (catch-all for fields without dedicated columns)
    metadata: {
      formData: formData ?? {},
      activeStep: pickInt(fs['Active Step']),
      forWho: fs['For who ?'] ?? null,
      aiDescription: pickStr(fs.ai_description),
      clientDescription: pickStr(fs.client_description),
      isWhatsappRequest: pickBool(fs.is_whatsapp_request),
      conseillerNote: pickStr(fs['Conseiller Note']),
      urgenceConseiller: pickStr(fs['Urgence Conseiller']),
      originalFormData: fs['Original Form Data'] ?? null,
      originalRequestId: pickStr(fs['Original Request ID']),
      isFollowUp: pickBool(fs['Is Follow Up']),
      followUpDelayDays: pickInt(fs['Follow Up Delay Days']),
      completelyUnsatisfied: pickBool(fs.completelyUnsatisfied),
      clientLanguage: pickStr(fs.client_language),
      supportResponseModel: pickStr(fs.support_response_model),
      supportResponseOriginal: pickStr(fs.support_response_original),
      supportResponseOriginalLanguage: pickStr(fs.support_response_original_language),
      supportResponseTranslatedLanguage: pickStr(fs.support_response_translated_language),
      supportResponseDidTranslate: pickBool(fs.support_response_did_translate),
      supportResponseTranslatedAt: toIso(fs.support_response_translated_at),
      chatUnreadForCounselor: pickInt(fs.chat_unread_for_counselor),
      chatUnreadForClient: pickInt(fs.chat_unread_for_client),
      isArchived: pickBool(fs.isArchived),
      archivedAt: toIso(fs.archivedAt),
      lastModified: toIso(fs.lastModified),
      appointmentModification: fs.appointment_modification ?? null,
      crmResponseRDVDate: pickStr(fs.CRM_ResponseRDVDate),
      crmResponseRDVHours: pickStr(fs.CRM_ResponseRDVHours),
      crmResponseRDVName: pickStr(fs.CRM_ResponseRDVName),
      reasonsCancel: pickArray(fs.reasonsCancel),
      method: pickStr(fs.Method),
    },
  };

  // Remove null/undefined to avoid overwriting existing data
  for (const k of Object.keys(row)) {
    if (row[k] === undefined || row[k] === null) delete row[k];
  }

  if (row.metadata) {
    for (const k of Object.keys(row.metadata)) {
      if (row.metadata[k] === null || row.metadata[k] === undefined) delete row.metadata[k];
    }
    if (Object.keys(row.metadata).length === 0) delete row.metadata;
  }

  return row;
}

// ---------------------------------------------------------------------------
// Discover mode: scan all request fields across all clients
// ---------------------------------------------------------------------------
async function discoverFields(): Promise<void> {
  const db = getFirestore();
  const fieldCounts = new Map<string, number>();
  const fieldSamples = new Map<string, any>();
  let totalClients = 0;
  let totalRequests = 0;
  let lastDoc: FirebaseFirestore.QueryDocumentSnapshot | null = null;

  console.log('\n=== REQUEST FIELD DISCOVERY MODE ===\n');

  while (true) {
    let q = db.collection('Clients').orderBy('__name__').limit(200);
    if (lastDoc) q = q.startAfter(lastDoc);
    const snap = await q.get();
    if (snap.empty) break;

    for (const clientDoc of snap.docs) {
      totalClients++;
      const reqSnap = await clientDoc.ref.collection('Requests').get();
      for (const reqDoc of reqSnap.docs) {
        totalRequests++;
        for (const [key, val] of Object.entries(reqDoc.data())) {
          fieldCounts.set(key, (fieldCounts.get(key) || 0) + 1);
          if (!fieldSamples.has(key) && val !== null && val !== undefined && val !== '') {
            fieldSamples.set(
              key,
              typeof val === 'object' ? JSON.stringify(val).slice(0, 120) : String(val).slice(0, 120),
            );
          }
        }
      }
    }
    lastDoc = snap.docs[snap.docs.length - 1];
    process.stdout.write(`\r  Scanned ${totalClients} clients, ${totalRequests} requests...`);
  }

  console.log(`\n\nClients: ${totalClients} | Requests: ${totalRequests} | Unique fields: ${fieldCounts.size}\n`);
  const sorted = [...fieldCounts.entries()].sort((a, b) => b[1] - a[1]);
  console.log('Field Name'.padEnd(45) + 'Count'.padStart(8) + '  Sample');
  console.log('-'.repeat(110));
  for (const [field, count] of sorted) {
    console.log(`${field.padEnd(45)}${String(count).padStart(8)}  ${(fieldSamples.get(field) || '(empty)').slice(0, 55)}`);
  }
}

// ---------------------------------------------------------------------------
// Backfill
// ---------------------------------------------------------------------------
interface BackfillReport {
  totalClients: number;
  totalRequests: number;
  updated: number;
  skipped: number;
  notFoundInSupabase: number;
  conseillerResolved: number;
  conseillerUnresolved: string[];
  errors: { uid: string; requestId: string; error: string }[];
}

const badColumns = new Set<string>();

async function backfillRequest(
  uid: string,
  requestId: string,
  fsData: Record<string, any>,
  report: BackfillReport,
): Promise<void> {
  const row = mapFullRequest(uid, requestId, fsData);

  for (const col of badColumns) delete row[col];

  // Track conseiller resolution
  const assignedTo = pickStr(fsData['Assigned to']);
  if (assignedTo) {
    if (row.assigned_to_conseiller_id) {
      report.conseillerResolved++;
    } else if (!report.conseillerUnresolved.includes(assignedTo)) {
      report.conseillerUnresolved.push(assignedTo);
    }
  }

  let maxRetries = 15;
  while (maxRetries-- > 0) {
    const { data, error, count } = await supabase
      .from('requests')
      .update(row)
      .eq('firebase_request_id', requestId)
      .eq('user_id', uid)
      .select('id', { count: 'exact', head: true });

    if (!error) {
      if (!data || (count !== null && count === 0)) {
        report.notFoundInSupabase++;
      } else {
        report.updated++;
      }
      return;
    }

    const colMatch = error.message?.match(
      /(?:column "([^"]+)".*does not exist|Could not find the '([^']+)' column)/,
    );
    const badCol = colMatch?.[1] || colMatch?.[2];
    if (badCol) {
      badColumns.add(badCol);
      delete row[badCol];
      continue;
    }

    report.errors.push({ uid, requestId, error: error.message });
    return;
  }

  report.errors.push({ uid, requestId, error: 'Too many missing columns' });
}

async function backfillAll(dryRun: boolean, targetUid?: string): Promise<void> {
  const db = getFirestore();
  const report: BackfillReport = {
    totalClients: 0,
    totalRequests: 0,
    updated: 0,
    skipped: 0,
    notFoundInSupabase: 0,
    conseillerResolved: 0,
    conseillerUnresolved: [],
    errors: [],
  };
  const batchSize = 100;

  console.log(`\n=== BACKFILL REQUESTS ${dryRun ? '(DRY RUN) ' : ''}===\n`);
  console.log('  Loading caches...');
  await loadConseillerCache();
  await loadClientCache();

  if (targetUid) {
    const clientRef = db.collection('Clients').doc(targetUid);
    const clientSnap = await clientRef.get();
    if (!clientSnap.exists) {
      console.log(`Client ${targetUid} not found in Firestore.`);
      return;
    }

    const reqSnap = await clientRef.collection('Requests').get();
    report.totalClients = 1;
    report.totalRequests = reqSnap.size;
    console.log(`  Found ${reqSnap.size} requests for client ${targetUid}\n`);

    for (const reqDoc of reqSnap.docs) {
      const mapped = mapFullRequest(targetUid, reqDoc.id, reqDoc.data());

      if (hasFlag('debug')) {
        console.log(`\n--- Request ${reqDoc.id} ---`);
        console.log('Firestore fields:', Object.keys(reqDoc.data()).sort().join(', '));
        console.log('Mapped row:', JSON.stringify(mapped, null, 2));
        continue;
      }

      if (dryRun) {
        console.log(`  [DRY] ${reqDoc.id}: ${Object.keys(mapped).length} fields mapped`);
        report.skipped++;
        continue;
      }

      await backfillRequest(targetUid, reqDoc.id, reqDoc.data(), report);
    }
  } else {
    let lastDoc: FirebaseFirestore.QueryDocumentSnapshot | null = null;
    let pageCount = 0;

    while (true) {
      let q = db.collection('Clients').orderBy('__name__').limit(batchSize);
      if (lastDoc) q = q.startAfter(lastDoc);
      const snap = await q.get();
      if (snap.empty) break;

      pageCount++;

      for (const clientDoc of snap.docs) {
        report.totalClients++;

        const reqSnap = await clientDoc.ref.collection('Requests').get();
        if (reqSnap.empty) continue;

        for (const reqDoc of reqSnap.docs) {
          report.totalRequests++;

          if (dryRun) {
            report.skipped++;
            continue;
          }

          await backfillRequest(clientDoc.id, reqDoc.id, reqDoc.data(), report);
        }
      }

      lastDoc = snap.docs[snap.docs.length - 1];
      process.stdout.write(
        `\r  Page ${pageCount} | ${report.totalClients} clients | ${report.totalRequests} requests | ${report.updated} updated | ${report.errors.length} errors`,
      );
    }
  }

  // Final report
  console.log('\n\n=== REPORT ===');
  console.log(`Clients scanned:       ${report.totalClients}`);
  console.log(`Requests found:        ${report.totalRequests}`);
  console.log(`Updated in Supabase:   ${report.updated}`);
  console.log(`Skipped (dry-run):     ${report.skipped}`);
  console.log(`Not found in Supabase: ${report.notFoundInSupabase}`);
  console.log(`Conseiller resolved:   ${report.conseillerResolved}`);
  console.log(`Errors:                ${report.errors.length}`);

  if (report.conseillerUnresolved.length > 0) {
    console.log(`\nUnresolved conseiller names (${report.conseillerUnresolved.length}):`);
    for (const name of report.conseillerUnresolved.sort()) {
      console.log(`  - "${name}"`);
    }
  }

  if (badColumns.size > 0) {
    console.log(`\nSkipped columns (don't exist in Supabase): ${[...badColumns].join(', ')}`);
  }

  if (report.errors.length > 0) {
    console.log('\nError details:');
    const grouped = new Map<string, { uid: string; requestId: string }[]>();
    for (const e of report.errors) {
      const arr = grouped.get(e.error) || [];
      arr.push({ uid: e.uid, requestId: e.requestId });
      grouped.set(e.error, arr);
    }
    for (const [msg, items] of grouped) {
      console.log(`  "${msg}" (${items.length}):`);
      for (const item of items.slice(0, 5)) {
        console.log(`    client=${item.uid} request=${item.requestId}`);
      }
      if (items.length > 5) console.log(`    ... and ${items.length - 5} more`);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  initializeFirebase();

  if (hasFlag('discover')) {
    await discoverFields();
  } else {
    await backfillAll(hasFlag('dry-run'), pickArg('uid') || undefined);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
