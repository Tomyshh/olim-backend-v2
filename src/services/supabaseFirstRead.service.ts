import { supabase } from './supabase.service.js';

const LOG_PREFIX = '[supabaseFirstRead]';

/**
 * Generic helper: try reading from Supabase first, fall back to Firestore if Supabase
 * returns null/empty or throws. Only throws if BOTH sources fail.
 */
export async function supabaseFirstRead<T>(
  supabaseRead: () => Promise<T>,
  firestoreRead: () => Promise<T>,
  context: string
): Promise<T> {
  try {
    const result = await supabaseRead();
    if (result !== null && result !== undefined) return result;
    throw new Error('Supabase returned null/empty');
  } catch (supabaseErr) {
    console.warn(LOG_PREFIX, `[${context}] Supabase read failed, falling back to Firestore`, supabaseErr);
    try {
      return await firestoreRead();
    } catch (firestoreErr) {
      console.error(LOG_PREFIX, `[${context}] BOTH Supabase and Firestore reads failed`, {
        supabaseErr,
        firestoreErr,
      });
      throw firestoreErr;
    }
  }
}

/**
 * Read client basic info (name, email, language, membership) from Supabase first,
 * falling back to Firestore. Used across many controllers.
 */
export async function readClientInfo(
  uid: string,
  firestoreGetter: () => Promise<Record<string, any>>
): Promise<Record<string, any>> {
  return supabaseFirstRead(
    async () => {
      const { data, error } = await supabase
        .from('clients')
        .select('*')
        .eq('firebase_uid', uid)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null as any;
      return {
        'First Name': data.first_name ?? '',
        'Last Name': data.last_name ?? '',
        Email: data.email ?? '',
        'Phone Number': data.phone ?? '',
        language: data.language ?? null,
        membership: data.membership_type ? { type: data.membership_type } : null,
        Membership: data.membership_type ?? null,
        freeAccess: data.free_access ?? null,
        fcmTokens: data.fcm_tokens ?? [],
        lastFcmToken: data.last_fcm_token ?? null,
        securden_Folder: data.securden_folder ?? null,
        firstName: data.first_name ?? '',
        lastName: data.last_name ?? '',
        _supabaseId: data.id,
        _source: 'supabase',
      };
    },
    firestoreGetter,
    `readClientInfo(${uid})`
  );
}

/**
 * Read subscription data from Supabase first, falling back to Firestore.
 */
export async function readSubscription(
  uid: string,
  firestoreGetter: () => Promise<{ exists: boolean; data: Record<string, any> | null }>
): Promise<{ exists: boolean; data: Record<string, any> | null }> {
  return supabaseFirstRead(
    async () => {
      const { data: client } = await supabase
        .from('clients')
        .select('id')
        .eq('firebase_uid', uid)
        .maybeSingle();
      if (!client?.id) return null as any;

      const { data, error } = await supabase
        .from('subscriptions')
        .select('*')
        .eq('client_id', client.id)
        .maybeSingle();
      if (error) throw error;
      if (!data) return { exists: false, data: null };

      return {
        exists: true,
        data: mapSupabaseSubscriptionToLegacy(data),
      };
    },
    firestoreGetter,
    `readSubscription(${uid})`
  );
}

/**
 * Map Supabase subscription row back to the legacy Firestore document shape
 * so the existing business logic continues to work without changes.
 */
function mapSupabaseSubscriptionToLegacy(row: Record<string, any>): Record<string, any> {
  return {
    plan: {
      type: row.plan_type ?? null,
      membership: row.membership_type ?? null,
      price: row.price_cents ?? null,
      basePriceInCents: row.base_price_cents ?? row.price_cents ?? null,
      familySupplementTotalInCents: row.family_supplement_cents ?? null,
      familySupplementCount: row.family_supplement_count ?? null,
    },
    payme: {
      subCode: row.payme_sub_code ?? null,
      subID: row.payme_sub_id ?? null,
      subId: row.payme_sub_id ?? null,
      buyerKey: row.payme_buyer_key ?? null,
      status: row.payme_status ?? null,
      sub_status: row.payme_status ?? null,
      nextPaymentDate: row.next_payment_date ?? null,
    },
    pricing: {
      basePriceInCents: row.base_price_cents ?? null,
      chargedPriceInCents: row.price_cents ?? null,
      discountInCents: row.discount_cents ?? 0,
      pricingSource: row.pricing_source ?? null,
      promo: row.promo_data ?? null,
    },
    states: {
      isActive: row.is_active ?? false,
      willExpire: row.will_expire ?? false,
    },
    dates: {
      endDate: row.end_date ?? null,
      startDate: row.start_date ?? null,
    },
    payment: {
      nextPaymentDate: row.next_payment_date ?? null,
      lastPaymentDate: row.last_payment_date ?? null,
      status: row.payment_status ?? null,
    },
    isUnpaid: row.is_unpaid ?? false,
    status: row.status ?? null,
    promoCode: row.promo_code ?? null,
    membership: row.membership_type ?? null,
    updatedAt: row.updated_at ?? null,
    createdAt: row.created_at ?? null,
    _source: 'supabase',
  };
}

/**
 * Read a payment credential from Supabase first, falling back to Firestore.
 */
export async function readPaymentCredential(
  uid: string,
  credentialId: string,
  firestoreGetter: () => Promise<{ exists: boolean; data: Record<string, any> | null }>
): Promise<{ exists: boolean; data: Record<string, any> | null }> {
  return supabaseFirstRead(
    async () => {
      const { data, error } = await supabase
        .from('payment_credentials')
        .select('*')
        .eq('firestore_id', credentialId)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null as any;
      return {
        exists: true,
        data: {
          'Card Name': data.card_name ?? null,
          'Card Number': data.card_masked ?? null,
          'Card Holder': data.card_name ?? null,
          'Card Suffix': data.card_masked?.replace(/\D+/g, '').slice(-4) ?? '',
          'Isracard Key': data.buyer_key ?? '',
          'Securden ID': data.securden_id ?? null,
          isSubscriptionCard: data.is_subscription_card ?? false,
          isDefault: data.is_default ?? false,
          last4: data.card_masked?.replace(/\D+/g, '').slice(-4) ?? '',
          brand: data.metadata?.brand ?? '',
          expiryMonth: data.metadata?.expiryMonth ?? null,
          expiryYear: data.metadata?.expiryYear ?? null,
          createdAt: data.created_at ?? null,
          updatedAt: data.updated_at ?? null,
          _source: 'supabase',
        },
      };
    },
    firestoreGetter,
    `readPaymentCredential(${uid}, ${credentialId})`
  );
}

/**
 * Read all payment credentials for a client from Supabase first, falling back to Firestore.
 */
export async function readAllPaymentCredentials(
  uid: string,
  firestoreGetter: () => Promise<Array<{ id: string; data: Record<string, any> }>>
): Promise<Array<{ id: string; data: Record<string, any> }>> {
  return supabaseFirstRead(
    async () => {
      const { data: client } = await supabase
        .from('clients')
        .select('id')
        .eq('firebase_uid', uid)
        .maybeSingle();
      if (!client?.id) return null as any;

      const { data, error } = await supabase
        .from('payment_credentials')
        .select('*')
        .eq('client_id', client.id);
      if (error) throw error;
      if (!data || data.length === 0) return [];

      return data.map((d: any) => ({
        id: d.firestore_id ?? d.id,
        data: {
          'Card Name': d.card_name ?? null,
          'Card Number': d.card_masked ?? null,
          'Card Holder': d.card_name ?? null,
          'Card Suffix': d.card_masked?.replace(/\D+/g, '').slice(-4) ?? '',
          'Isracard Key': d.buyer_key ?? '',
          'Securden ID': d.securden_id ?? null,
          isSubscriptionCard: d.is_subscription_card ?? false,
          isDefault: d.is_default ?? false,
          last4: d.card_masked?.replace(/\D+/g, '').slice(-4) ?? '',
          brand: d.metadata?.brand ?? '',
          expiryMonth: d.metadata?.expiryMonth ?? null,
          expiryYear: d.metadata?.expiryYear ?? null,
          createdAt: d.created_at ?? null,
          updatedAt: d.updated_at ?? null,
        },
      }));
    },
    firestoreGetter,
    `readAllPaymentCredentials(${uid})`
  );
}

/**
 * Map a Supabase family_members row back to the Firestore document shape
 * so that existing business logic (billing, eligibility checks) continues to work.
 */
function mapSupabaseFamilyMemberToLegacy(row: Record<string, any>): Record<string, any> {
  const birthday = row.birthday
    ? formatBirthdayDdMmYyyy(row.birthday)
    : null;

  return {
    'First Name': row.first_name ?? '',
    'Last Name': row.last_name ?? null,
    'Father Name': row.father_name ?? null,
    Email: row.email ?? null,
    'Phone Number': row.phone ?? null,
    phoneNumbers: row.phone ? [row.phone] : [],
    'Teoudat Zeout': row.teoudat_zeout ?? null,
    'Koupat Holim': row.koupat_holim ?? null,
    Birthday: birthday,
    age: row.age ?? null,
    'Family Member Status': row.relationship_type ?? row.status ?? '',
    isAccountOwner: row.is_account_owner ?? false,
    isActive: row.is_active ?? true,
    isChild: row.is_child ?? null,
    livesAtHome: row.lives_at_home ?? false,
    serviceActive: row.service_active ?? false,
    billingExempt: row.billing_exempt ?? false,
    billingExemptReason: row.billing_exempt_reason ?? null,
    validationStatus: row.validation_status ?? 'en_attente',
    selectedCardId: row.selected_card_id ?? null,
    serviceActivatedAt: row.service_activated_at ?? null,
    serviceActivationPaymentId: row.service_activation_payment_id ?? null,
    monthlySupplementApplied: row.monthly_supplement_applied ?? false,
    monthlySupplementNis: row.monthly_supplement_nis ?? null,
    hasGOVacces: row.has_gov_access ?? false,
    isConnected: row.is_connected ?? false,
    deactivatedAt: row.deactivated_at ?? null,
    reactivatedAt: row.reactivated_at ?? null,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
    _source: 'supabase',
  };
}

function formatBirthdayDdMmYyyy(isoOrDate: string): string | null {
  if (!isoOrDate) return null;
  const m = String(isoOrDate).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return isoOrDate;
  return `${m[3]}/${m[2]}/${m[1]}`;
}

/**
 * Read a single family member from Supabase first, falling back to Firestore.
 */
export async function readFamilyMember(
  uid: string,
  memberId: string,
  firestoreGetter: () => Promise<{ exists: boolean; data: Record<string, any> | null }>
): Promise<{ exists: boolean; data: Record<string, any> | null }> {
  return supabaseFirstRead(
    async () => {
      const { data: client } = await supabase
        .from('clients')
        .select('id')
        .eq('firebase_uid', uid)
        .maybeSingle();
      if (!client?.id) return null as any;

      const { data, error } = await supabase
        .from('family_members')
        .select('*')
        .eq('client_id', client.id)
        .eq('firestore_id', memberId)
        .maybeSingle();
      if (error) throw error;
      if (!data) return { exists: false, data: null };
      return {
        exists: true,
        data: mapSupabaseFamilyMemberToLegacy(data),
      };
    },
    firestoreGetter,
    `readFamilyMember(${uid}, ${memberId})`
  );
}

/**
 * Read all family members for a client from Supabase first, falling back to Firestore.
 * Returns an array of { id, data } matching the Firestore document format.
 */
export async function readFamilyMembers(
  uid: string,
  firestoreGetter: () => Promise<Array<{ id: string; data: Record<string, any> }>>
): Promise<Array<{ id: string; data: Record<string, any> }>> {
  return supabaseFirstRead(
    async () => {
      const { data: client } = await supabase
        .from('clients')
        .select('id')
        .eq('firebase_uid', uid)
        .maybeSingle();
      if (!client?.id) return null as any;

      const { data, error } = await supabase
        .from('family_members')
        .select('*')
        .eq('client_id', client.id);
      if (error) throw error;
      if (!data || data.length === 0) return [];

      return data.map((row: any) => ({
        id: row.firestore_id ?? row.id,
        data: mapSupabaseFamilyMemberToLegacy(row),
      }));
    },
    firestoreGetter,
    `readFamilyMembers(${uid})`
  );
}

/**
 * Read conseillers from Supabase first, falling back to Firestore.
 */
export async function readAvailableConseillers(
  firestoreGetter: () => Promise<Array<Record<string, any>>>
): Promise<Array<Record<string, any>>> {
  return supabaseFirstRead(
    async () => {
      const { data, error } = await supabase
        .from('conseillers')
        .select('*')
        .eq('is_present', true);
      if (error) throw error;
      if (!data || data.length === 0) return null as any;
      return data.map((c: any) => ({
        name: c.name ?? '',
        isPresent: c.is_present ?? false,
        language: c.language ?? {},
        now_request: c.now_request ?? 0,
      }));
    },
    firestoreGetter,
    'readAvailableConseillers'
  );
}
