import 'dotenv/config';
import { initializeFirebase, getFirestore } from '../src/config/firebase.js';
import { createClient } from '@supabase/supabase-js';
import {
  resolveMembershipTypeId,
  clearAllCaches,
} from '../src/services/dualWrite.service.js';

/**
 * backfill-clients-supabase.ts
 *
 * Re-reads ALL Firestore client documents and updates every Supabase `clients` row
 * with complete data from Firestore, including columns added after the initial migration.
 *
 * 100% READ-ONLY on Firestore.
 *
 * Usage:
 *   npx tsx scripts/backfill-clients-supabase.ts                     # full backfill
 *   npx tsx scripts/backfill-clients-supabase.ts --dry-run            # preview only
 *   npx tsx scripts/backfill-clients-supabase.ts --discover           # field discovery
 *   npx tsx scripts/backfill-clients-supabase.ts --uid <uid>          # single client
 *   npx tsx scripts/backfill-clients-supabase.ts --uid <uid> --debug  # show mapped data
 */

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
if (!supabaseUrl || !supabaseKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SECRET_KEY');
  process.exit(1);
}
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const hasFlag = (name: string) => process.argv.includes(`--${name}`);
function pickArg(name: string): string {
  const idx = process.argv.findIndex((x) => x === `--${name}`);
  if (idx >= 0) return String(process.argv[idx + 1] || '').trim();
  return '';
}

// ---------------------------------------------------------------------------
// Date helpers
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

function toDateOnly(v: unknown): string | null {
  const iso = toIso(v);
  if (!iso) return null;
  const m = iso.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function pickStr(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') { const s = v.trim(); return s || null; }
  if (typeof v === 'number') return String(v);
  return null;
}

function normalizeMembershipSlug(raw: string | null): string | null {
  if (!raw) return null;
  return raw.toLowerCase().replace(/\s+/g, '_');
}

// ---------------------------------------------------------------------------
// Complete Firestore → Supabase mapping (all 99 fields)
// ---------------------------------------------------------------------------

async function mapFullClient(uid: string, fs: Record<string, any>): Promise<Record<string, any>> {
  const membershipType = pickStr(fs.Membership) ?? pickStr(fs.membership?.type) ?? pickStr(fs.membershipType);
  let membershipTypeId: string | null = null;
  if (membershipType) {
    const slug = normalizeMembershipSlug(membershipType);
    if (slug) membershipTypeId = await resolveMembershipTypeId(slug);
  }

  const phone = fs['Phone Number'];
  let primaryPhone: string | null = null;
  if (typeof phone === 'string') primaryPhone = phone;
  else if (Array.isArray(phone) && phone.length > 0) primaryPhone = phone[0];

  const row: Record<string, any> = {
    // Core identity
    firebase_uid: uid,
    firestore_id: uid,
    email: pickStr(fs.Email) ?? pickStr(fs.email),
    first_name: pickStr(fs['First Name']) ?? pickStr(fs.firstName),
    last_name: pickStr(fs['Last Name']) ?? pickStr(fs.lastName),
    father_name: pickStr(fs['Father Name']) ?? pickStr(fs.fatherName),
    civility: pickStr(fs.Civility) ?? pickStr(fs.civility),
    birthday: toDateOnly(fs.Birthday) ?? toDateOnly(fs.birthday),
    teoudat_zeout: pickStr(fs['Teoudat Zeout']) ?? pickStr(fs.teoudatZeout),
    koupat_holim: pickStr(fs['Koupat Holim']) ?? pickStr(fs.koupatHolim),
    language: pickStr(fs.language) ?? 'fr',
    phone: primaryPhone,

    // Registration
    registration_complete: fs.registrationComplete ?? false,
    registration_completed_at: toIso(fs.registrationCompletedAt),
    informations_filled: fs.informations_filled ?? false,
    is_first_visit: fs.isFirstVisit ?? null,
    created_via: pickStr(fs.createdVia),

    // Membership
    membership_type: membershipType,
    membership_type_id: membershipTypeId,
    membership_status: pickStr(fs.membership?.status) ?? pickStr(fs.membershipStatus),
    is_unpaid: fs.isUnpaid ?? false,
    has_gov_access: fs.hasGOVAccess ?? fs.hasGOVacces ?? null,

    // Free access (JSONB)
    free_access: fs.freeAccess ?? null,

    // Seniority (JSONB)
    seniority: fs.seniority ?? null,

    // Promo
    promo_code_used: pickStr(fs.promoCodeUsed),
    promo_code_expiration_date: toIso(fs.codePromoExpirationDate),
    promo_code_reduction: typeof fs['Promo Code Reduction'] === 'number' ? fs['Promo Code Reduction'] : null,
    promo_code_source: pickStr(fs['Promo Code Source']) ?? pickStr(fs.codePromoSource),

    // Source / folder
    created_from: pickStr(fs['Created From']) ?? pickStr(fs.createdFrom) ?? pickStr(fs.createdVia),
    securden_folder: pickStr(fs['Securden folder']) ?? pickStr(fs.securden_Folder),

    // Subscription hints
    subscription_plan: pickStr(fs['Subscription Plan']) ?? pickStr(fs.subPlan),
    is_annual_subscription: fs.is_annual_subscription ?? null,
    annual_expiration_date: toIso(fs.annual_expiration_date),
    isracard_sub_code: pickStr(fs['IsraCard Sub Code']) ?? pickStr(fs.israCard_subCode),
    isracard_sub_id: pickStr(fs['IsraCard Sub ID']),

    // Activity
    last_login_at: toIso(fs.lastLoginAt),
    last_active_at: toIso(fs.activity?.lastActiveAt) ?? toIso(fs.activity?.lastActive),
    activity_score: typeof fs.activity?.score === 'number' ? fs.activity.score : null,
    total_requests: typeof fs.totalRequests === 'number' ? fs.totalRequests : null,
    last_request_at: toIso(fs.lastRequestDate),

    // Phone verification
    phone_verified: fs.phoneVerified ?? false,
    phone_verified_at: toIso(fs.phoneVerifiedAt),
    verified_phone_number: pickStr(fs.verifiedPhoneNumber),

    // Photo
    profile_photo_url: pickStr(fs.profilePhotoUrl) ?? pickStr(fs['Profile Photo']) ?? pickStr(fs.photoURL),

    // Mirpaa / Elite
    mirpaa_name: pickStr(fs.mirpaa_name),
    elite_onboarding_done: fs.elite_onboarding_request_created ?? false,

    // Metadata (catch-all for data not in dedicated columns)
    metadata: {
      activity: fs.activity ?? null,
      devices: fs.Devices ?? [],
      subscriptionPlan: fs['Subscription Plan'] ?? null,
      israCardSubCode: fs['IsraCard Sub Code'] ?? fs.israCard_subCode ?? null,
      israCardSubId: fs['IsraCard Sub ID'] ?? null,
      membershipPrice: fs['Membership Price'] ?? null,
      lastMembershipUpdate: toIso(fs['Last Membership Update']),
      lastUnpaidCheck: toIso(fs.lastUnpaidCheck),
      lastAdShownAt: toIso(fs.lastAdShownAt),
      registration: fs.registration ?? null,
      salePaymeId: pickStr(fs.sale_payme_id),
      paymeSubID: pickStr(fs.paymeSubID),
      selectedInstallments: fs.selected_installments ?? null,
      useCustomPrice: fs.useCustomPrice ?? null,
      subscriptionStartDate: pickStr(fs['Subscription Start Date']),
      lastChangeMembership: toIso(fs.lastChangeMembership),
      updatedByAdminUid: pickStr(fs.updatedByAdminUid),
      updatedByAdminAt: toIso(fs.updatedByAdminAt),
      mergedAt: toIso(fs.mergedAt),
      mergedFromPhones: fs.mergedFromPhones ?? null,
      mergedFromAuthUids: fs.mergedFromAuthUids ?? null,
      mergedIntoUid: pickStr(fs.mergedIntoUid),
      mergedReason: pickStr(fs.mergedReason),
      unpaidGracePeriod: fs.unpaidGracePeriodStart ? {
        start: toIso(fs.unpaidGracePeriodStart),
        expires: toIso(fs.unpaidGracePeriodExpires),
      } : null,
      subscriptionCancelledDate: toIso(fs.subscription_cancelled_date),
      cancellationReason: pickStr(fs.cancellation_reason),
      previousMembership: pickStr(fs.previous_membership),
      lastCancellationNotice: fs.lastCancellationNoticeShownAt ? {
        shownAt: toIso(fs.lastCancellationNoticeShownAt),
        nextPaymentDate: pickStr(fs.lastCancellationNoticeNextPaymentDate),
      } : null,
      promoDetails: (fs.promoPrice || fs.promoEndDate) ? {
        promoPrice: fs.promoPrice ?? null,
        originalPrice: fs.originalPrice ?? null,
        currentPrice: fs.currentSubscriptionPrice ?? null,
        duration: fs.promoDuration ?? null,
        endDate: toIso(fs.promoEndDate),
      } : null,
      eliteOnboarding: fs.elite_onboarding_request_created ? {
        createdAt: toIso(fs.elite_onboarding_request_created_at),
        assignedTo: pickStr(fs.elite_onboarding_assigned_to),
      } : null,
      _sync: fs._sync ?? null,
    },

    // Timestamps
    created_at: toIso(fs['Created At']) ?? toIso(fs.createdAt),
    updated_at: new Date().toISOString(),
  };

  // Clean null/undefined values to avoid overwriting existing data with null
  for (const k of Object.keys(row)) {
    if (row[k] === undefined || row[k] === null) delete row[k];
  }

  // Clean null entries inside metadata
  if (row.metadata) {
    for (const k of Object.keys(row.metadata)) {
      if (row.metadata[k] === null || row.metadata[k] === undefined) delete row.metadata[k];
    }
  }

  return row;
}

// ---------------------------------------------------------------------------
// Discover mode
// ---------------------------------------------------------------------------

async function discoverFields(): Promise<void> {
  const db = getFirestore();
  const fieldCounts = new Map<string, number>();
  const fieldSamples = new Map<string, any>();
  let total = 0;
  let lastDoc: FirebaseFirestore.QueryDocumentSnapshot | null = null;

  console.log('\n=== FIELD DISCOVERY MODE ===\n');

  while (true) {
    let q = db.collection('Clients').orderBy('__name__').limit(200);
    if (lastDoc) q = q.startAfter(lastDoc);
    const snap = await q.get();
    if (snap.empty) break;

    for (const doc of snap.docs) {
      total++;
      for (const [key, val] of Object.entries(doc.data())) {
        fieldCounts.set(key, (fieldCounts.get(key) || 0) + 1);
        if (!fieldSamples.has(key) && val !== null && val !== undefined && val !== '') {
          fieldSamples.set(key, typeof val === 'object' ? JSON.stringify(val).slice(0, 120) : String(val).slice(0, 120));
        }
      }
    }
    lastDoc = snap.docs[snap.docs.length - 1];
    process.stdout.write(`\r  Scanned ${total} clients...`);
  }

  console.log(`\n\nTotal: ${total} | Unique fields: ${fieldCounts.size}\n`);
  const sorted = [...fieldCounts.entries()].sort((a, b) => b[1] - a[1]);
  console.log('Field Name'.padEnd(40) + 'Count'.padStart(8) + '  Sample');
  console.log('-'.repeat(100));
  for (const [field, count] of sorted) {
    console.log(`${field.padEnd(40)}${String(count).padStart(8)}  ${(fieldSamples.get(field) || '(empty)').slice(0, 50)}`);
  }
}

// ---------------------------------------------------------------------------
// Backfill
// ---------------------------------------------------------------------------

interface BackfillReport {
  total: number;
  updated: number;
  skipped: number;
  errors: { uid: string; error: string }[];
}

const badColumns = new Set<string>();

async function backfillClient(uid: string, fsData: Record<string, any>, report: BackfillReport): Promise<void> {
  let row = await mapFullClient(uid, fsData);

  for (const col of badColumns) delete row[col];

  let maxRetries = 15;
  while (maxRetries-- > 0) {
    const { error } = await supabase.from('clients').update(row).eq('firebase_uid', uid);

    if (!error) { report.updated++; return; }

    const colMatch = error.message?.match(/(?:column "([^"]+)".*does not exist|Could not find the '([^']+)' column)/);
    const badCol = colMatch?.[1] || colMatch?.[2];
    if (badCol) {
      badColumns.add(badCol);
      delete row[badCol];
      continue;
    }

    report.errors.push({ uid, error: error.message });
    return;
  }

  report.errors.push({ uid, error: 'Too many missing columns' });
}

async function backfillAll(dryRun: boolean, targetUid?: string): Promise<void> {
  const db = getFirestore();
  const report: BackfillReport = { total: 0, updated: 0, skipped: 0, errors: [] };
  const batchSize = 100;

  console.log(`\n=== BACKFILL ${dryRun ? '(DRY RUN) ' : ''}===\n`);

  if (targetUid) {
    const snap = await db.collection('Clients').doc(targetUid).get();
    if (!snap.exists) { console.log(`Client ${targetUid} not found.`); return; }
    report.total = 1;

    if (hasFlag('debug')) {
      const row = await mapFullClient(targetUid, snap.data()!);
      console.log('Mapped row:\n', JSON.stringify(row, null, 2));
      return;
    }
    if (dryRun) {
      console.log('Fields:', Object.keys(snap.data()!).sort().join(', '));
      return;
    }
    await backfillClient(targetUid, snap.data()!, report);
  } else {
    let lastDoc: FirebaseFirestore.QueryDocumentSnapshot | null = null;
    let pageCount = 0;

    while (true) {
      let q = db.collection('Clients').orderBy('__name__').limit(batchSize);
      if (lastDoc) q = q.startAfter(lastDoc);
      const snap = await q.get();
      if (snap.empty) break;

      pageCount++;

      for (const doc of snap.docs) {
        report.total++;
        if (dryRun) { report.skipped++; continue; }
        await backfillClient(doc.id, doc.data(), report);
      }

      lastDoc = snap.docs[snap.docs.length - 1];
      process.stdout.write(`\r  Page ${pageCount} | ${report.total} total | ${report.updated} updated | ${report.errors.length} errors`);
    }
  }

  console.log('\n\n=== REPORT ===');
  console.log(`Total:    ${report.total}`);
  console.log(`Updated:  ${report.updated}`);
  console.log(`Skipped:  ${report.skipped}`);
  console.log(`Errors:   ${report.errors.length}`);

  if (badColumns.size > 0) {
    console.log(`\nSkipped columns (don't exist): ${[...badColumns].join(', ')}`);
  }

  if (report.errors.length > 0) {
    console.log('\nError details:');
    const grouped = new Map<string, string[]>();
    for (const e of report.errors) {
      const arr = grouped.get(e.error) || [];
      arr.push(e.uid);
      grouped.set(e.error, arr);
    }
    for (const [msg, uids] of grouped) {
      console.log(`  "${msg}" (${uids.length}): ${uids.slice(0, 5).join(', ')}${uids.length > 5 ? '...' : ''}`);
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
