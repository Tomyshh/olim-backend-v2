import { supabase } from './supabase.service.js';

const LOG_PREFIX = '[dualWrite]';

// ---------------------------------------------------------------------------
// Core dual-write engine
// ---------------------------------------------------------------------------

type DualWriteMode = 'upsert' | 'insert' | 'update' | 'delete';

interface DualWriteOptions {
  onConflict?: string;
  mode?: DualWriteMode;
  matchColumn?: string;
  matchValue?: unknown;
}

async function logFailure(table: string, operation: string, payload: unknown, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  try {
    await supabase.from('dual_write_failures').insert({
      target_table: table,
      operation,
      payload: typeof payload === 'object' ? payload : { value: payload },
      error_message: message,
      error_stack: stack ?? null
    });
  } catch (logErr) {
    console.error(LOG_PREFIX, 'Failed to log dual-write failure', logErr);
  }
}

export async function dualWriteToSupabase(
  table: string,
  data: Record<string, any>,
  options: DualWriteOptions = {}
): Promise<void> {
  const mode = options.mode ?? 'upsert';
  try {
    for (const k of Object.keys(data)) {
      if (data[k] === undefined) delete data[k];
    }

    let result: { error: any };

    switch (mode) {
      case 'insert':
        result = await supabase.from(table).insert(data);
        break;
      case 'update':
        if (!options.matchColumn || options.matchValue === undefined) {
          throw new Error('update mode requires matchColumn and matchValue');
        }
        result = await supabase.from(table).update(data).eq(options.matchColumn, options.matchValue);
        break;
      case 'delete':
        if (!options.matchColumn || options.matchValue === undefined) {
          throw new Error('delete mode requires matchColumn and matchValue');
        }
        result = await supabase.from(table).delete().eq(options.matchColumn, options.matchValue);
        break;
      case 'upsert':
      default:
        result = await supabase.from(table).upsert(data, {
          onConflict: options.onConflict ?? 'id'
        });
        break;
    }

    if (result.error) {
      console.error(LOG_PREFIX, `${mode} on ${table} failed:`, result.error.message);
      await logFailure(table, mode, data, result.error);
      throw result.error;
    }
  } catch (err) {
    console.error(LOG_PREFIX, `${mode} on ${table} threw:`, err);
    await logFailure(table, mode, data, err);
    throw err;
  }
}

export async function dualWriteDelete(
  table: string,
  column: string,
  value: unknown
): Promise<void> {
  return dualWriteToSupabase(table, {}, { mode: 'delete', matchColumn: column, matchValue: value });
}

// ---------------------------------------------------------------------------
// Helper: resolve Supabase client UUID from firebase_uid
// ---------------------------------------------------------------------------

let clientIdCache = new Map<string, string>();

export async function resolveSupabaseClientId(firebaseUid: string): Promise<string | null> {
  const cached = clientIdCache.get(firebaseUid);
  if (cached) return cached;

  const { data } = await supabase
    .from('clients')
    .select('id')
    .eq('firebase_uid', firebaseUid)
    .maybeSingle();

  if (data?.id) {
    clientIdCache.set(firebaseUid, data.id);
    return data.id;
  }
  return null;
}

export function clearClientIdCache(): void {
  clientIdCache = new Map();
  firebaseUidCache = new Map();
}

let firebaseUidCache = new Map<string, string>();

/**
 * Given either a Supabase UUID or a Firebase UID, resolves to the Firebase UID.
 * CRM routes receive Supabase UUIDs from the frontend, but subscription
 * controllers need Firebase UIDs for Firestore lookups.
 */
export async function resolveClientFirebaseUid(clientIdOrUid: string): Promise<string | null> {
  const cached = firebaseUidCache.get(clientIdOrUid);
  if (cached) return cached;

  const { data } = await supabase
    .from('clients')
    .select('firebase_uid')
    .or(`id.eq.${clientIdOrUid},firebase_uid.eq.${clientIdOrUid}`)
    .limit(1)
    .maybeSingle();

  const uid = data?.firebase_uid ?? null;
  if (uid) {
    firebaseUidCache.set(clientIdOrUid, uid);
  }
  return uid;
}

// ---------------------------------------------------------------------------
// Helpers: resolve lookup table UUIDs (cached)
// ---------------------------------------------------------------------------

type LookupTable = 'document_types' | 'membership_types' | 'plan_types' | 'relationship_types';
const lookupCaches = new Map<LookupTable, Map<string, string>>();

async function resolveLookupId(table: LookupTable, slug: string): Promise<string | null> {
  if (!slug) return null;
  let cache = lookupCaches.get(table);
  if (!cache) {
    cache = new Map();
    const { data } = await supabase.from(table).select('id, slug');
    if (data) {
      for (const row of data) cache.set(row.slug, row.id);
    }
    lookupCaches.set(table, cache);
  }
  return cache.get(slug) ?? null;
}

export async function resolveDocumentTypeId(slug: string): Promise<string | null> {
  return resolveLookupId('document_types', slug);
}
export async function resolveMembershipTypeId(slug: string): Promise<string | null> {
  return resolveLookupId('membership_types', slug);
}
export async function resolvePlanTypeId(slug: string): Promise<string | null> {
  return resolveLookupId('plan_types', slug);
}
export async function resolveRelationshipTypeId(slug: string): Promise<string | null> {
  return resolveLookupId('relationship_types', slug);
}

let conseillerIdCache = new Map<string, string>();

export async function resolveConseillerUuid(firestoreId: string): Promise<string | null> {
  if (!firestoreId || firestoreId === 'unknown') return null;
  const cached = conseillerIdCache.get(firestoreId);
  if (cached) return cached;

  const { data } = await supabase
    .from('conseillers')
    .select('id')
    .eq('firestore_id', firestoreId)
    .maybeSingle();

  if (data?.id) {
    conseillerIdCache.set(firestoreId, data.id);
    return data.id;
  }
  return null;
}

export function clearAllCaches(): void {
  clientIdCache = new Map();
  lookupCaches.clear();
  conseillerIdCache = new Map();
}

function normalizeMembershipSlug(raw: string | null): string | null {
  if (!raw) return null;
  return raw.toLowerCase().replace(/\s+/g, '_');
}

function normalizePlanSlug(raw: string | null): string | null {
  if (!raw) return null;
  const lower = raw.toLowerCase().trim();
  if (lower === 'annualy' || lower === 'anually') return 'annual';
  if (lower === 'free') return 'monthly';
  return lower;
}

function normalizeDocumentTypeSlug(raw: string): string {
  const s = raw.toLowerCase().trim();
  if (s.includes('teoudat z') || s.includes('teudat z') || s.includes('תעודת זהות') || s === 'tz') return 'teudat_zehut';
  if (s.includes('teoudat ol')) return 'teudat_ole';
  if (s.includes('passeport') && (s.includes('etranger') || s.includes('franc'))) return 'passeport_etranger';
  if (s.includes('passeport') || s === 'passport') return 'passeport';
  if (s.includes('permis de conduire') || s === 'driving license') return 'permis_conduire';
  if (s.includes('carte de cr') || s.includes('credit card')) return 'carte_credit';
  if (s.includes("carte d'identit") || s.includes('carte d\'identit')) return 'carte_identite';
  if (s.includes('carte grise') || s.includes('vehicle registration')) return 'carte_grise';
  if (s.includes('koupat') || s.includes('health fund')) return 'carte_koupat_holim';
  if (s.includes('contrat de location') || s.includes('rental contract')) return 'contrat_location';
  if (s.includes('compteur') && s.includes('eau') || s.includes('water meter')) return 'compteur_eau';
  if (s.includes('compteur') && s.includes('gaz')) return 'compteur_gaz';
  if (s.includes('compteur') && (s.includes('lectricit') || s.includes('lectr')) || s.includes('electricity meter')) return 'compteur_electricite';
  if (s.includes('arnona')) return 'facture_arnona';
  if (s.includes("facture d'eau") || s.includes('facture deau')) return 'facture_eau';
  if (s.includes('facture de gaz')) return 'facture_gaz';
  if (s.includes("facture d'") && s.includes('lectricit') || s.includes('electricity bill')) return 'facture_electricite';
  if (s.includes('facture') && s.includes('phone')) return 'facture_telephone';
  if (s.includes('fiche de paie') || s.includes('bulletin') && s.includes('salaire')) return 'fiche_paie';
  if (s.includes('relev') && (s.includes('bancaire') || s.includes('compte'))) return 'releve_bancaire';
  if (s === 'rib') return 'rib';
  if (s.includes('sefah')) return 'sefah';
  if (s.includes('acte de naissance')) return 'acte_naissance';
  if (s.includes('assurance auto')) return 'assurance_auto';
  if (s.includes('assurance habitation') || s.includes('home insurance')) return 'assurance_habitation';
  if (s.includes('attestation') && s.includes('travail')) return 'attestation_travail';
  if (s.includes('ordonnance')) return 'ordonnance';
  if (s.includes("photos d'identit") || s.includes('photos d\'identit')) return 'photos_identite';
  if (s.includes('justificatif') && s.includes('revenus')) return 'justificatif_revenus';
  if (s.includes('dipl')) return 'diplome';
  if (s.includes('document m') && s.includes('dic') || s.includes('rapport') && s.includes('dic')) return 'document_medical';
  if (s.includes('profile_photo') || s === 'profile photo') return 'profile_photo';
  if (s.includes('request_attachment')) return 'request_attachment';
  return 'autre';
}

// ---------------------------------------------------------------------------
// Helper: safe timestamp conversion
// ---------------------------------------------------------------------------

function toIso(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && 'toDate' in (value as any)) {
    try { return (value as any).toDate().toISOString(); } catch { return null; }
  }
  if (typeof value === 'number') return new Date(value).toISOString();
  return null;
}

function pickStr(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/**
 * Converts date strings like "22/01/1996" (DD/MM/YYYY) or "1996-01-22"
 * to PostgreSQL-compatible "YYYY-MM-DD". Returns null on invalid input.
 */
function toDateOnly(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === 'object' && 'toDate' in (value as any)) {
    try {
      const d = (value as any).toDate() as Date;
      return d.toISOString().slice(0, 10);
    } catch { return null; }
  }
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s) return null;

  // DD/MM/YYYY or DD-MM-YYYY
  const dmy = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/);
  if (dmy) {
    const [, dd, mm, yyyy] = dmy;
    const d = Number(dd), m = Number(mm), y = Number(yyyy);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 1900 && y <= 2100) {
      return `${yyyy}-${mm!.padStart(2, '0')}-${dd!.padStart(2, '0')}`;
    }
  }

  // Already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  // ISO datetime → extract date part
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return s.slice(0, 10);

  return null;
}

// ---------------------------------------------------------------------------
// Entity mappers: Firestore doc data → Supabase row
// ---------------------------------------------------------------------------

export function mapClientToSupabase(uid: string, fs: Record<string, any>): Record<string, any> {
  return {
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
    registration_complete: fs.registrationComplete ?? false,
    registration_completed_at: toIso(fs.registrationCompletedAt),
    has_gov_access: fs.hasGOVAccess ?? fs.hasGOVacces ?? null,
    membership_type: pickStr(fs.Membership) ?? pickStr(fs.membership?.type) ?? pickStr(fs.membershipType),
    membership_status: pickStr(fs.membership?.status) ?? pickStr(fs.membershipStatus),
    is_unpaid: fs.isUnpaid ?? false,
    free_access: fs.freeAccess ?? null,
    seniority: fs.seniority ?? null,
    created_from: pickStr(fs.createdFrom) ?? pickStr(fs['Created From']) ?? pickStr(fs.createdVia),
    securden_folder: pickStr(fs.securden_Folder) ?? pickStr(fs['Securden folder']),
    promo_code_used: pickStr(fs.promoCodeUsed),
    last_login_at: toIso(fs.lastLoginAt),
    metadata: {
      activity: fs.activity ?? null,
      devices: fs.Devices ?? [],
      subscriptionPlan: fs['Subscription Plan'] ?? null,
      israCardSubCode: fs['IsraCard Sub Code'] ?? fs.israCard_subCode ?? null,
      israCardSubId: fs['IsraCard Sub ID'] ?? null
    },
    created_at: toIso(fs['Created At']) ?? toIso(fs.createdAt),
    updated_at: new Date().toISOString()
  };
}

export async function mapSubscriptionToSupabase(
  clientSupabaseId: string,
  fs: Record<string, any>
): Promise<Record<string, any>> {
  const planType = pickStr(fs.plan?.type) ?? pickStr(fs.planType);
  const membershipType = pickStr(fs.plan?.membership) ?? pickStr(fs.membershipType);

  const [membershipTypeId, planTypeId] = await Promise.all([
    resolveMembershipTypeId(normalizeMembershipSlug(membershipType) ?? ''),
    resolvePlanTypeId(normalizePlanSlug(planType) ?? ''),
  ]);

  return {
    client_id: clientSupabaseId,
    plan_type: planType,
    membership_type: membershipType,
    membership_type_id: membershipTypeId,
    plan_type_id: planTypeId,
    price_cents: fs.plan?.price ?? fs.priceInCents ?? null,
    base_price_cents: fs.plan?.basePriceInCents ?? fs.basePriceInCents ?? null,
    currency: pickStr(fs.plan?.currency) ?? 'ILS',
    payment_method: pickStr(fs.payment?.method),
    installments: fs.payment?.installments ?? null,
    next_payment_at: toIso(fs.payment?.nextPaymentDate),
    last_payment_at: toIso(fs.payment?.lastPaymentDate),
    payme_sub_code: fs.payme?.subCode ?? null,
    payme_sub_id: pickStr(fs.payme?.subID),
    payme_buyer_key: pickStr(fs.payme?.buyerKey),
    payme_status: pickStr(typeof fs.payme?.status === 'number' ? String(fs.payme.status) : fs.payme?.status),
    payme_sub_status: typeof fs.payme?.status === 'number' ? fs.payme.status : (fs.payme?.subStatus ?? null),
    is_unpaid: fs.isUnpaid ?? fs.states?.isUnpaid ?? false,
    is_active: fs.states?.isActive ?? null,
    is_paused: fs.states?.isPaused ?? null,
    will_expire: fs.states?.willExpire ?? null,
    is_annual: fs.states?.isAnnual ?? null,
    family_supplement_cents: fs.plan?.familySupplementTotalInCents ?? fs.familySupplement?.monthlyCents ?? fs.familySupplementTotalInCents ?? null,
    family_supplement_count: fs.plan?.familySupplementCount ?? fs.familySupplementCount ?? null,
    promo_code: pickStr(fs.promoCode?.code),
    promo_source: pickStr(fs.promoCode?.source),
    promo_applied_at: toIso(fs.promoCode?.appliedDate),
    promo_expires_at: toIso(fs.promoCode?.expiresAt),
    start_at: toIso(fs.dates?.startDate),
    end_at: toIso(fs.dates?.endDate),
    cancelled_at: toIso(fs.dates?.cancelledDate),
    resumed_at: toIso(fs.dates?.resumedDate),
    metadata: {
      source: fs.source ?? null,
      updatedBy: fs.updatedBy ?? null,
      raw_states: fs.states ?? null
    },
    created_at: toIso(fs.createdAt) ?? new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
}

export async function mapFamilyMemberToSupabase(
  clientSupabaseId: string,
  memberId: string,
  fs: Record<string, any>
): Promise<Record<string, any>> {
  const status = pickStr(fs['Family Member Status']) ?? pickStr(fs.status);
  const relationshipTypeId = await resolveRelationshipTypeFromStatus(status);

  return {
    client_id: clientSupabaseId,
    firestore_id: memberId,
    first_name: pickStr(fs['First Name']) ?? pickStr(fs.firstName),
    last_name: pickStr(fs['Last Name']) ?? pickStr(fs.lastName),
    father_name: pickStr(fs['Father Name']) ?? pickStr(fs.fatherName),
    birthday: toDateOnly(fs.Birthday) ?? toDateOnly(fs.birthday),
    teoudat_zeout: pickStr(fs['Teoudat Zeout']) ?? pickStr(fs.teoudatZeout),
    koupat_holim: pickStr(fs['Koupat Holim']) ?? pickStr(fs.koupatHolim),
    email: pickStr(fs.Email) ?? pickStr(fs.email),
    phone: Array.isArray(fs['Phone Number']) ? pickStr(fs['Phone Number'][0]) : pickStr(fs['Phone Number']) ?? pickStr(fs.phone),
    status,
    relationship_type: pickStr(fs['Family Member Status']) ?? pickStr(fs.relationshipType) ?? status,
    relationship_type_id: relationshipTypeId,
    is_account_owner: fs.isAccountOwner ?? (memberId === 'account_owner'),
    is_active: fs.isActive ?? true,
    deactivated_at: toIso(fs.deactivatedAt),
    monthly_supplement_cents: fs.monthlySupplement?.amountCents ?? fs.monthlySupplementCents ?? null,
    has_gov_access: fs.hasGOVacces ?? fs.hasGovAccess ?? fs.has_gov_access ?? null,
    is_connected: fs.isConnected ?? null,
    lives_at_home: fs.livesAtHome ?? null,
    service_active: fs.serviceActive ?? fs.service_active ?? null,
    billing_exempt: fs.billingExempt ?? fs.billing_exempt ?? null,
    billing_exempt_reason: pickStr(fs.billingExemptReason) ?? pickStr(fs.billing_exempt_reason),
    validation_status: pickStr(fs.validationStatus) ?? pickStr(fs.validation_status),
    is_child: fs.isChild ?? fs.is_child ?? null,
    service_activated_at: toIso(fs.serviceActivatedAt),
    reactivated_at: toIso(fs.reactivatedAt),
    selected_card_id: pickStr(fs.selectedCardId) ?? pickStr(fs.selected_card_id),
    metadata: {},
    created_at: toIso(fs.createdAt) ?? toIso(fs['Created At']) ?? new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
}

const KNOWN_RELATIONSHIP_SLUGS = ['account_owner', 'conjoint', 'parent', 'child', 'sibling', 'grandparent', 'other'];

async function resolveRelationshipTypeFromStatus(status: string | null): Promise<string | null> {
  if (!status) return null;
  const s = status.toLowerCase().trim();
  let slug: string;
  // Si le frontend envoie déjà un slug Supabase, l'utiliser directement
  if (KNOWN_RELATIONSHIP_SLUGS.includes(s)) {
    slug = s;
  } else if (s.includes('account owner')) {
    slug = 'account_owner';
  } else if (['conjoin', 'spouse', 'partner', 'mari'].includes(s) || s.includes('conjoint')) {
    slug = 'conjoint';
  } else if (['boy', 'girl', 'daughter', 'fille', 'fils', 'garçon', 'beau fils'].includes(s)) {
    slug = 'child';
  } else if (['father', 'mother', 'mere', 'mère', 'pere', 'père'].includes(s) || s.includes('mere') || s.includes('pere')) {
    slug = 'parent';
  } else if (s.includes('grand')) {
    slug = 'grandparent';
  } else if (s.includes('soeur') || s.includes('frere')) {
    slug = 'sibling';
  } else {
    slug = 'other';
  }
  return resolveRelationshipTypeId(slug);
}

export function mapAddressToSupabase(
  clientSupabaseId: string,
  addressId: string,
  fs: Record<string, any>
): Record<string, any> {
  return {
    client_id: clientSupabaseId,
    firestore_id: addressId,
    label: pickStr(fs.Name) ?? pickStr(fs.name) ?? pickStr(fs.label),
    name: pickStr(fs.Name) ?? pickStr(fs.name),
    address1: pickStr(fs.Address) ?? pickStr(fs.address),
    address2: pickStr(fs['Additional address']) ?? pickStr(fs.additionalInfo),
    additional_info: pickStr(fs.additionalInfo) ?? pickStr(fs['Additional address']),
    apartment: pickStr(fs.Appartment) ?? pickStr(fs.apartment),
    floor: pickStr(fs.Etage) ?? pickStr(fs.floor),
    details: pickStr(fs.details),
    is_primary: addressId === 'primary' || fs.isPrimary === true,
    is_active: fs.isActive ?? true,
    order_index: typeof fs.orderIndex === 'number' ? fs.orderIndex : 0,
    metadata: {},
    created_at: toIso(fs.createdAt) ?? new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
}

export function mapPaymentCredentialToSupabase(
  clientSupabaseId: string,
  credId: string,
  fs: Record<string, any>
): Record<string, any> {
  return {
    client_id: clientSupabaseId,
    firestore_id: credId,
    provider: 'payme',
    buyer_key: pickStr(fs['Isracard Key']) ?? pickStr(fs.buyerKey) ?? pickStr(fs.isracard_key),
    card_masked: pickStr(fs['Card Number']) ?? pickStr(fs.cardNumber),
    card_type: pickStr(fs['Card Type']) ?? pickStr(fs.cardType) ?? pickStr(fs.brand),
    card_name: pickStr(fs['Card Holder']) ?? pickStr(fs['Card Name']) ?? pickStr(fs.cardName),
    securden_id: pickStr(fs['Securden ID']) ?? pickStr(fs.securdenId),
    securden_folder: pickStr(fs.securden?.folderId) ?? pickStr(fs.securdenFolder),
    is_default: fs.isDefault ?? false,
    is_subscription_card: fs.isSubscriptionCard ?? false,
    metadata: {
      brand: pickStr(fs.brand),
      expiryMonth: fs.expiryMonth ?? null,
      expiryYear: fs.expiryYear ?? null,
      last4: pickStr(fs.last4) ?? pickStr(fs['Card Suffix']),
      createdFrom: pickStr(fs['Created From'])
    },
    created_at: toIso(fs['Created At']) ?? toIso(fs.createdAt) ?? new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
}

export function mapChatConversationToSupabase(
  clientSupabaseId: string,
  convoId: string,
  fs: Record<string, any>
): Record<string, any> {
  return {
    firestore_id: convoId,
    client_id: clientSupabaseId,
    request_id: pickStr(fs.requestId),
    title: pickStr(fs.title) ?? 'Nouvelle conversation',
    metadata: {},
    created_at: toIso(fs.createdAt),
    updated_at: toIso(fs.updatedAt) ?? new Date().toISOString()
  };
}

export function mapChatMessageToSupabase(
  conversationSupabaseId: string,
  msgId: string,
  fs: Record<string, any>
): Record<string, any> {
  return {
    firestore_id: msgId,
    conversation_id: conversationSupabaseId,
    sender_id: pickStr(fs.senderId) ?? '',
    sender_name: pickStr(fs.senderName),
    content: pickStr(fs.content),
    type: pickStr(fs.type) ?? 'text',
    attachments: fs.attachments ?? [],
    is_read: fs.read ?? false,
    read_at: toIso(fs.readAt),
    created_at: toIso(fs.createdAt)
  };
}

export function mapAppointmentToSupabase(
  clientSupabaseId: string,
  apptId: string,
  fs: Record<string, any>
): Record<string, any> {
  return {
    firestore_id: apptId,
    client_id: clientSupabaseId,
    request_id: pickStr(fs.requestId),
    slot_id: pickStr(fs.slotId),
    appointment_date: pickStr(fs.date),
    appointment_time: pickStr(fs.time),
    status: pickStr(fs.status) ?? 'scheduled',
    notes: pickStr(fs.notes) ?? '',
    metadata: {},
    created_at: toIso(fs.createdAt),
    updated_at: toIso(fs.updatedAt) ?? new Date().toISOString()
  };
}

export function mapNotificationToSupabase(
  clientSupabaseId: string,
  notifId: string,
  fs: Record<string, any>
): Record<string, any> {
  return {
    firestore_id: notifId,
    client_id: clientSupabaseId,
    title: pickStr(fs.title),
    body: pickStr(fs.body),
    type: pickStr(fs.type),
    is_read: fs.read ?? false,
    read_at: toIso(fs.readAt),
    data: fs.data ?? {},
    metadata: {},
    created_at: toIso(fs.createdAt)
  };
}

export function mapSupportTicketToSupabase(
  clientSupabaseId: string | null,
  ticketId: string,
  uid: string,
  fs: Record<string, any>
): Record<string, any> {
  return {
    firestore_id: ticketId,
    client_id: clientSupabaseId,
    client_firebase_uid: uid,
    subject: pickStr(fs.subject) ?? '',
    description: pickStr(fs.description),
    priority: pickStr(fs.priority) ?? 'normal',
    status: pickStr(fs.status) ?? 'open',
    metadata: {},
    created_at: toIso(fs.createdAt),
    updated_at: toIso(fs.updatedAt) ?? new Date().toISOString()
  };
}

export function mapContactMessageToSupabase(
  msgId: string,
  fs: Record<string, any>
): Record<string, any> {
  return {
    firestore_id: msgId,
    client_firebase_uid: pickStr(fs.uid),
    name: pickStr(fs.name),
    email: pickStr(fs.email),
    phone: pickStr(fs.phone),
    subject: pickStr(fs.subject),
    message: pickStr(fs.message),
    status: pickStr(fs.status) ?? 'new',
    created_at: toIso(fs.createdAt)
  };
}

export function mapHealthRequestToSupabase(
  clientSupabaseId: string | null,
  reqId: string,
  uid: string,
  fs: Record<string, any>
): Record<string, any> {
  return {
    firestore_id: reqId,
    client_id: clientSupabaseId,
    client_firebase_uid: uid,
    request_type: pickStr(fs.type) ?? 'general',
    description: pickStr(fs.description) ?? '',
    data: fs.data ?? {},
    status: pickStr(fs.status) ?? 'pending',
    metadata: {},
    created_at: toIso(fs.createdAt),
    updated_at: new Date().toISOString()
  };
}

export function mapRequestDraftToSupabase(
  clientSupabaseId: string,
  draftId: string,
  fs: Record<string, any>
): Record<string, any> {
  return {
    firestore_id: draftId,
    client_id: clientSupabaseId,
    draft_type: pickStr(fs.type) ?? 'manual_conversational',
    title: pickStr(fs.title),
    category: pickStr(fs.category),
    subcategory: pickStr(fs.subcategory),
    progress: typeof fs.progress === 'number' ? fs.progress : 0,
    current_step: pickStr(fs.current_step),
    snapshot_json: fs.snapshot_json ?? {},
    uploaded_urls: fs.uploaded_urls ?? [],
    client_temp_id: pickStr(fs.client_temp_id),
    expires_at: toIso(fs.expires_at),
    created_at: toIso(fs.created_at),
    updated_at: toIso(fs.updated_at) ?? new Date().toISOString()
  };
}

export function mapRefundRequestToSupabase(
  clientSupabaseId: string | null,
  refundId: string,
  uid: string,
  fs: Record<string, any>
): Record<string, any> {
  return {
    firestore_id: refundId,
    client_id: clientSupabaseId,
    client_firebase_uid: uid,
    amount_cents: fs.amountCents ?? fs.amount_cents ?? null,
    reason: pickStr(fs.reason),
    status: pickStr(fs.status) ?? 'pending',
    metadata: fs.metadata ?? {},
    created_at: toIso(fs.createdAt),
    updated_at: new Date().toISOString()
  };
}

export function mapPromoRevertToSupabase(
  revertId: string,
  fs: Record<string, any>
): Record<string, any> {
  return {
    firestore_id: revertId,
    client_firebase_uid: pickStr(fs.uid) ?? '',
    promo_code: pickStr(fs.promoCode),
    promotion_id: pickStr(fs.promotionId),
    revert_at: toIso(fs.revertAt),
    base_price_cents: fs.basePriceInCents ?? null,
    discounted_price_cents: fs.discountedPriceInCents ?? null,
    plan_type: pickStr(fs.planType),
    membership_type: pickStr(fs.membershipType),
    payme_sub_id: pickStr(fs.paymeSubId),
    duration_cycles: fs.durationCycles ?? null,
    status: pickStr(fs.status) ?? 'pending',
    source: pickStr(fs.source),
    completed_at: toIso(fs.completedAt),
    skip_reason: pickStr(fs.skipReason),
    last_error: pickStr(fs.lastError),
    last_error_at: toIso(fs.lastErrorAt),
    created_at: toIso(fs.createdAt)
  };
}

export function mapPromotionToSupabase(
  promoId: string,
  fs: Record<string, any>
): Record<string, any> {
  return {
    firestore_id: promoId,
    code: pickStr(fs.code) ?? promoId,
    code_normalized: pickStr(fs.codeNormalized),
    is_valid: fs.isValid ?? true,
    for_everyone: fs.forEveryone ?? false,
    membership_type: pickStr(fs.membershipType) ?? pickStr(fs.membership),
    applicable_memberships: fs.applicableMemberships ?? fs.membershipTypes ?? [],
    plan_type: pickStr(fs.plan) ?? pickStr(fs.planType),
    applicable_plans: fs.plans ?? fs.planTypes ?? [],
    discount_percent: fs.percentOff ?? fs.discountPercent ?? fs.reductionPercent ?? fs.reduction ?? null,
    discount_amount_cents: fs.amountOffCents ?? fs.discountInCents ?? fs.reductionInCents ?? null,
    duration_cycles: fs.promo_duration ?? fs.promoDuration ?? fs.durationCycles ?? fs.duration ?? null,
    expiration_date: toIso(fs.expirationDate) ?? toIso(fs.expiresAt) ?? toIso(fs.expiryDate),
    source: pickStr(fs.source),
    used_by_uid: pickStr(fs.usedByUid),
    used_at: toIso(fs.usedAt),
    metadata: {},
    created_at: toIso(fs.created_at),
    updated_at: new Date().toISOString()
  };
}

export function mapFavoriteRequestToSupabase(
  clientSupabaseId: string,
  favId: string,
  fs: Record<string, any>
): Record<string, any> {
  return {
    firestore_id: favId,
    client_id: clientSupabaseId,
    category_id: pickStr(fs.categoryId),
    sub_category_id: pickStr(fs.subCategoryId),
    category_title: pickStr(fs.categoryTitle),
    sub_category_title: pickStr(fs.subCategoryTitle),
    request_type: pickStr(fs.type),
    last_used: toIso(fs.lastUsed),
    created_at: new Date().toISOString()
  };
}

// ---------------------------------------------------------------------------
// Settings mapper
// ---------------------------------------------------------------------------

export function mapSettingsToSupabase(
  clientSupabaseId: string,
  preferences: Record<string, any>
): Record<string, any> {
  return {
    client_id: clientSupabaseId,
    preferences: preferences ?? {},
    updated_at: new Date().toISOString()
  };
}

// ---------------------------------------------------------------------------
// Tip like / saved tip mappers
// ---------------------------------------------------------------------------

export function mapTipLikeToSupabase(
  tipId: string,
  firebaseUid: string
): Record<string, any> {
  return {
    id: `${tipId}_${firebaseUid}`,
    tip_id: tipId,
    client_firebase_uid: firebaseUid,
    created_at: new Date().toISOString()
  };
}

export function mapUserSavedTipToSupabase(
  clientSupabaseId: string | null,
  tipId: string,
  firebaseUid: string,
  data: Record<string, any> = {}
): Record<string, any> {
  return {
    id: `${tipId}_${firebaseUid}`,
    tip_id: tipId,
    client_id: clientSupabaseId,
    client_firebase_uid: firebaseUid,
    content: pickStr(data.content),
    title: pickStr(data.title),
    saved_at: toIso(data.savedAt) ?? new Date().toISOString()
  };
}

// ---------------------------------------------------------------------------
// Convenience wrappers for common dual-write patterns
// ---------------------------------------------------------------------------

export async function dualWriteClient(uid: string, fsData: Record<string, any>): Promise<void> {
  const row = mapClientToSupabase(uid, fsData);
  await dualWriteToSupabase('clients', row, { onConflict: 'firebase_uid' });
}

export async function dualWriteSubscription(
  firebaseUid: string,
  fsData: Record<string, any>
): Promise<void> {
  const clientId = await resolveSupabaseClientId(firebaseUid);
  if (!clientId) {
    console.warn(LOG_PREFIX, 'Cannot write subscription: client not found in Supabase', firebaseUid);
    return;
  }
  const row = await mapSubscriptionToSupabase(clientId, fsData);
  await dualWriteToSupabase('subscriptions', row, { onConflict: 'client_id' });
}

export async function dualWriteFamilyMember(
  firebaseUid: string,
  memberId: string,
  fsData: Record<string, any>,
  options?: { insertOnly?: boolean }
): Promise<void> {
  const clientId = await resolveSupabaseClientId(firebaseUid);
  if (!clientId) {
    console.warn(LOG_PREFIX, 'dualWriteFamilyMember: client not found in Supabase for firebaseUid=', firebaseUid);
    return;
  }
  const row = await mapFamilyMemberToSupabase(clientId, memberId, fsData);
  // Pour un nouveau membre (create), utiliser INSERT (pas de contrainte unique requise).
  // Pour update, upsert nécessite la contrainte (client_id, firestore_id).
  if (options?.insertOnly) {
    await dualWriteToSupabase('family_members', row, { mode: 'insert' });
  } else {
    await dualWriteToSupabase('family_members', row, {
      mode: 'upsert',
      onConflict: 'client_id,firestore_id',
    });
  }
}

export async function dualWriteAddress(
  firebaseUid: string,
  addressId: string,
  fsData: Record<string, any>
): Promise<void> {
  const clientId = await resolveSupabaseClientId(firebaseUid);
  if (!clientId) return;
  const row = mapAddressToSupabase(clientId, addressId, fsData);
  await dualWriteToSupabase('client_addresses', row, { onConflict: 'client_id,firestore_id' });
}

export async function dualWritePaymentCredential(
  firebaseUid: string,
  credId: string,
  fsData: Record<string, any>
): Promise<void> {
  const clientId = await resolveSupabaseClientId(firebaseUid);
  if (!clientId) return;
  const row = mapPaymentCredentialToSupabase(clientId, credId, fsData);
  await dualWriteToSupabase('payment_credentials', row, { onConflict: 'client_id,firestore_id' });
}

export async function dualWritePromoRevert(
  revertId: string,
  fsData: Record<string, any>
): Promise<void> {
  const row = mapPromoRevertToSupabase(revertId, fsData);
  await dualWriteToSupabase('promo_reverts', row, { mode: 'insert' });
}

export async function dualWritePromotion(
  promoId: string,
  fsData: Record<string, any>
): Promise<void> {
  const row = mapPromotionToSupabase(promoId, fsData);
  await dualWriteToSupabase('promotions', row, { onConflict: 'firestore_id' });
}

export async function dualWriteSettings(
  firebaseUid: string,
  preferences: Record<string, any>
): Promise<void> {
  const clientId = await resolveSupabaseClientId(firebaseUid);
  if (!clientId) return;
  const row = mapSettingsToSupabase(clientId, preferences);
  await dualWriteToSupabase('client_settings', row, { onConflict: 'client_id' });
}

export async function dualWriteTipLike(
  tipId: string,
  firebaseUid: string
): Promise<void> {
  const row = mapTipLikeToSupabase(tipId, firebaseUid);
  await dualWriteToSupabase('tip_likes', row, { mode: 'insert' });
}

export async function dualDeleteTipLike(
  tipId: string,
  firebaseUid: string
): Promise<void> {
  const rowId = `${tipId}_${firebaseUid}`;
  await dualWriteDelete('tip_likes', 'id', rowId);
}

export async function dualWriteSavedTip(
  firebaseUid: string,
  tipId: string,
  data: Record<string, any> = {}
): Promise<void> {
  const clientId = await resolveSupabaseClientId(firebaseUid);
  const row = mapUserSavedTipToSupabase(clientId, tipId, firebaseUid, data);
  await dualWriteToSupabase('user_saved_tips', row, { mode: 'insert' });
}

export async function dualDeleteSavedTip(
  tipId: string,
  firebaseUid: string
): Promise<void> {
  const rowId = `${tipId}_${firebaseUid}`;
  await dualWriteDelete('user_saved_tips', 'id', rowId);
}

// ---------------------------------------------------------------------------
// Legacy Request mapper
// ---------------------------------------------------------------------------

export function mapLegacyRequestToSupabase(
  uid: string,
  requestId: string,
  fs: Record<string, any>
): Record<string, any> {
  return {
    firebase_request_id: requestId,
    unique_id: `LEGACY-${requestId}-${uid.slice(0, 8)}`,
    user_id: uid,
    request_type: pickStr(fs['Request Type']) ?? 'unknown',
    request_category: pickStr(fs['Request Category']) ?? 'unknown',
    request_sub_category: pickStr(fs['Request Sub-Category']),
    request_description: pickStr(fs.Description),
    uploaded_files: fs['Uploaded Files'] ?? [],
    available_days: fs['Available Days'] ?? [],
    available_hours: fs['Available Hours'] ?? [],
    tags: fs.Tags ?? [],
    status: pickStr(fs.Status) ?? 'pending',
    priority: typeof fs.Priority === 'number' ? fs.Priority : null,
    assigned_to: pickStr(fs['Assigned to']),
    first_name: pickStr(fs['First Name']),
    last_name: pickStr(fs['Last Name']),
    email: pickStr(fs.Email),
    membership_type: pickStr(fs['Membership Type']),
    rating: typeof fs.rating === 'number' ? fs.rating : null,
    client_comment: pickStr(fs.ratingComment),
    source: 'LEGACY',
    platform: 'mobile',
    created_by: 'LEGACY',
    request_date: toIso(fs['Request Date']) ?? new Date().toISOString(),
    sync_source: 'backend',
    sync_date: new Date().toISOString(),
    metadata: { formData: fs['Form Data'] ?? {} }
  };
}

export async function dualWriteLegacyRequest(
  uid: string,
  requestId: string,
  fsData: Record<string, any>
): Promise<void> {
  const row = mapLegacyRequestToSupabase(uid, requestId, fsData);
  await dualWriteToSupabase('requests', row, { onConflict: 'unique_id' });
}

// ---------------------------------------------------------------------------
// Client Access Credentials mapper
// ---------------------------------------------------------------------------

export function mapAccesToSupabase(
  clientSupabaseId: string,
  accesId: string,
  fs: Record<string, any>
): Record<string, any> {
  return {
    firestore_id: accesId,
    client_id: clientSupabaseId,
    title: pickStr(fs.title) ?? pickStr(fs.name),
    username: pickStr(fs.username) ?? pickStr(fs.login),
    securden_id: pickStr(fs.securdenId) ?? pickStr(fs.securden_id),
    family_members: fs.familyMembers ?? fs.family_members ?? null,
    metadata: fs.metadata ?? {},
    created_at: toIso(fs.createdAt) ?? new Date().toISOString()
  };
}

export async function dualWriteAcces(
  firebaseUid: string,
  accesId: string,
  fsData: Record<string, any>
): Promise<void> {
  const clientId = await resolveSupabaseClientId(firebaseUid);
  if (!clientId) return;
  const row = mapAccesToSupabase(clientId, accesId, fsData);
  await dualWriteToSupabase('client_access_credentials', row, { mode: 'insert' });
}

// ---------------------------------------------------------------------------
// Client Logs mapper
// ---------------------------------------------------------------------------

export function mapClientLogToSupabase(
  clientSupabaseId: string,
  logId: string,
  fs: Record<string, any>
): Record<string, any> {
  return {
    firestore_id: logId,
    client_id: clientSupabaseId,
    action: pickStr(fs.action) ?? '',
    description: pickStr(fs.description) ?? '',
    metadata: fs.metadata ?? {},
    created_at: toIso(fs.createdAt) ?? new Date().toISOString()
  };
}

// ---------------------------------------------------------------------------
// Conseiller mapper
// ---------------------------------------------------------------------------

export function mapConseillerToSupabase(
  conseillerId: string,
  fs: Record<string, any>
): Record<string, any> {
  return {
    firestore_id: conseillerId,
    firebase_uid: conseillerId,
    name: fs.name ?? fs.Name ?? '',
    email: fs.email ?? null,
    is_admin: fs.isAdmin ?? fs.is_admin ?? false,
    is_super_admin: fs.isSuperAdmin ?? fs.is_super_admin ?? fs.superAdmin ?? false,
    is_present: fs.isPresent ?? fs.is_present ?? false,
    is_active: fs.isActive ?? fs.is_active ?? true,
    manage_elite: fs.manageElite ?? fs.manage_elite ?? false,
    languages: fs.languages ?? {},
    now_request: fs.nowRequest ?? fs.now_request ?? null,
    metadata: fs.metadata ?? {},
    updated_at: new Date().toISOString()
  };
}

export async function dualWriteConseiller(
  conseillerId: string,
  fsData: Record<string, any>
): Promise<void> {
  const row = mapConseillerToSupabase(conseillerId, fsData);
  await dualWriteToSupabase('conseillers', row, { onConflict: 'firestore_id' });
}

export async function dualWriteClientLog(
  firebaseUid: string,
  logId: string,
  fsData: Record<string, any>
): Promise<void> {
  const clientId = await resolveSupabaseClientId(firebaseUid);
  if (!clientId) return;
  const row = mapClientLogToSupabase(clientId, logId, fsData);
  await dualWriteToSupabase('client_logs', row, { mode: 'insert' });
}

// ---------------------------------------------------------------------------
// Document Upload mapper
// ---------------------------------------------------------------------------

export async function mapDocumentUploadToSupabase(
  clientSupabaseId: string,
  doc: Record<string, any>
): Promise<Record<string, any>> {
  const rawType = pickStr(doc.documentType) ?? 'personal';
  const typeSlug = normalizeDocumentTypeSlug(rawType);
  const documentTypeId = await resolveDocumentTypeId(typeSlug);

  const row: Record<string, any> = {
    client_id: clientSupabaseId,
    document_type: rawType,
    document_type_id: documentTypeId,
    file_url: pickStr(doc.url),
    file_path: pickStr(doc.path),
    file_name: pickStr(doc.originalName),
    content_type: pickStr(doc.contentType),
    file_size: typeof doc.size === 'number' ? doc.size : null,
    metadata: doc.metadata ?? {},
    created_at: new Date().toISOString(),
  };

  if (doc.supabaseStoragePath) row.supabase_storage_path = doc.supabaseStoragePath;
  if (doc.supabaseStorageBucket) row.supabase_storage_bucket = doc.supabaseStorageBucket;

  return row;
}

export async function dualWriteDocumentUpload(
  firebaseUid: string,
  docData: Record<string, any>
): Promise<void> {
  const clientId = await resolveSupabaseClientId(firebaseUid);
  if (!clientId) return;
  const row = await mapDocumentUploadToSupabase(clientId, docData);
  await dualWriteToSupabase('client_documents', row, { mode: 'insert' });
}
