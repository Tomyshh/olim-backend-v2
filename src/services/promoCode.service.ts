import { admin, getFirestore } from '../config/firebase.js';

export type PromoValidationOk = {
  ok: true;
  promoCodeNormalized: string;
  promotionId: string;
  discountType: 'percent' | 'amount';
  discountValue: number; // percent (0..100) ou amountInCents (>0)
  discountInCents: number; // calculé par rapport à basePriceInCents si percent
  basePriceInCents: number;
  finalPriceInCents: number;
  durationCycles: number | null;
  forEveryone: boolean;
  // audit
  membershipTypeNormalized: string;
  planNormalized: 'monthly' | 'annual';
  expiresAt: Date | null;
};

export type PromoValidationErr =
  | { ok: false; code: 'PROMO_INVALID' }
  | { ok: false; code: 'PROMO_EXPIRED' }
  | { ok: false; code: 'PROMO_NOT_APPLICABLE' };

function pickString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function digitsOnlyUpper(value: unknown): string {
  // On accepte codes type "START-10", " start10 " => "START10"
  const s = pickString(value);
  if (!s) return '';
  return s.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}

export function timestampToDate(value: any): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  const ts = (admin.firestore as any).Timestamp;
  if (ts && value instanceof ts) return value.toDate();
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value);
  if (typeof value === 'string') {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

export function isPromoActive(doc: Record<string, any>): boolean {
  // Beaucoup de schémas possibles: isValid / active / enabled
  if (doc.isValid === false) return false;
  if (doc.active === false) return false;
  if (doc.enabled === false) return false;
  return true;
}

function promoApplicableToMembership(doc: Record<string, any>, membership: string): boolean {
  const m = membership.trim();
  // Structure existante: forEveryone=true => applicable à tous les packs
  if (doc.forEveryone === true) return true;
  // Champs possibles: membershipType, membership, applicableMemberships, membershipTypes
  const single = pickString(doc.membershipType || doc.membership);
  if (single) {
    const s = single.trim();
    if (s.toLowerCase() === 'any') return true;
    return s === m;
  }
  const arr = Array.isArray(doc.applicableMemberships)
    ? doc.applicableMemberships
    : Array.isArray(doc.membershipTypes)
      ? doc.membershipTypes
      : null;
  if (arr) {
    const vals = arr.map((x: any) => pickString(x)).filter(Boolean);
    if (vals.some((v) => v.toLowerCase() === 'any')) return true;
    return vals.includes(m);
  }
  // Si pas de contrainte, on accepte (backward compatible)
  return true;
}

function promoApplicableToPlan(doc: Record<string, any>, plan: 'monthly' | 'annual'): boolean {
  const single = pickString(doc.plan || doc.planType);
  if (single) {
    const s = single.toLowerCase();
    if (s === 'any') return true;
    if (s === 'monthly' || s === 'annual') return s === plan;
  }
  const arr = Array.isArray(doc.plans) ? doc.plans : Array.isArray(doc.planTypes) ? doc.planTypes : null;
  if (arr) {
    const vals = arr.map((x: any) => pickString(x).toLowerCase()).filter(Boolean);
    if (vals.includes('any')) return true;
    return vals.includes(plan);
  }
  return true;
}

function extractDiscount(doc: Record<string, any>): { type: 'percent'; value: number } | { type: 'amount'; valueInCents: number } | null {
  // Supporte plusieurs champs possibles (pour matcher l’existant prod sans migration)
  const percentCandidates = [
    doc.percentOff,
    doc.discountPercent,
    doc.reductionPercent,
    // Structure existante: "reduction" (ex: 20) => % de réduction
    doc.reduction,
    doc.percent,
    doc.pct
  ];
  for (const v of percentCandidates) {
    const n = typeof v === 'string' ? Number(v.trim()) : typeof v === 'number' ? v : NaN;
    if (Number.isFinite(n) && n > 0 && n <= 100) return { type: 'percent', value: n };
  }

  const amountCentsCandidates = [doc.amountOffCents, doc.discountInCents, doc.reductionInCents];
  for (const v of amountCentsCandidates) {
    const n = typeof v === 'string' ? Number(v.trim()) : typeof v === 'number' ? v : NaN;
    if (Number.isFinite(n) && n > 0) return { type: 'amount', valueInCents: Math.floor(n) };
  }

  const amountNisCandidates = [doc.amountOffNis, doc.discountNis, doc.reductionNis, doc.amountOff];
  for (const v of amountNisCandidates) {
    const n = typeof v === 'string' ? Number(v.trim()) : typeof v === 'number' ? v : NaN;
    if (Number.isFinite(n) && n > 0) return { type: 'amount', valueInCents: Math.round(n * 100) };
  }

  // Heuristique: parfois "reduction" peut être un montant (NIS) au lieu d'un %.
  // Si réduction > 100, on l'interprète comme un montant NIS.
  const red = doc.reduction;
  const redN = typeof red === 'string' ? Number(red.trim()) : typeof red === 'number' ? red : NaN;
  if (Number.isFinite(redN) && redN > 100) {
    return { type: 'amount', valueInCents: Math.round(redN * 100) };
  }

  return null;
}

function extractPromoDurationCycles(doc: Record<string, any>): number | null {
  const v = doc.promo_duration ?? doc.promoDuration ?? doc.durationCycles ?? doc.duration;
  const n = typeof v === 'string' ? Number(v.trim()) : typeof v === 'number' ? v : NaN;
  if (!Number.isFinite(n)) return null;
  const k = Math.floor(n);
  if (k <= 0) return null;
  // Sécurité: limiter une promo à 24 cycles max par défaut
  return Math.min(k, 24);
}

export async function loadPromotionByCode(promoCodeNormalized: string): Promise<{ id: string; data: Record<string, any> } | null> {
  const { supabase } = await import('./supabase.service.js');
  const { supabaseFirstRead } = await import('./supabaseFirstRead.service.js');

  return supabaseFirstRead<{ id: string; data: Record<string, any> } | null>(
    async () => {
      const { data } = await supabase
        .from('promotions')
        .select('*')
        .or(`code.eq.${promoCodeNormalized},code_normalized.eq.${promoCodeNormalized},firestore_id.eq.${promoCodeNormalized}`)
        .limit(1)
        .single();

      if (!data) return null as any;

      return {
        id: data.firestore_id ?? data.id,
        data: {
          code: data.code,
          codeNormalized: data.code_normalized,
          isValid: data.is_valid,
          forEveryone: data.for_everyone,
          membershipType: data.membership_type,
          applicableMemberships: data.applicable_memberships ?? [],
          planType: data.plan_type,
          plans: data.applicable_plans ?? [],
          percentOff: data.discount_percent,
          amountOffCents: data.discount_amount_cents,
          promo_duration: data.duration_cycles,
          expirationDate: data.expiration_date,
          source: data.source,
          usedByUid: data.used_by_uid,
          usedAt: data.used_at,
        },
      };
    },
    async () => {
      const db = getFirestore();
      const docSnap = await db.collection('Promotions').doc(promoCodeNormalized).get();
      if (docSnap.exists) {
        return { id: docSnap.id, data: (docSnap.data() ?? {}) as Record<string, any> };
      }
      const byCode = await db
        .collection('Promotions')
        .where('code', '==', promoCodeNormalized)
        .limit(1)
        .get();
      if (!byCode.empty) {
        const d = byCode.docs[0];
        return { id: d.id, data: (d.data() ?? {}) as Record<string, any> };
      }
      const byNormalized = await db
        .collection('Promotions')
        .where('codeNormalized', '==', promoCodeNormalized)
        .limit(1)
        .get();
      if (!byNormalized.empty) {
        const d = byNormalized.docs[0];
        return { id: d.id, data: (d.data() ?? {}) as Record<string, any> };
      }
      return null;
    },
    `loadPromotionByCode(${promoCodeNormalized})`
  );
}

export async function validateAndApplyPromo(params: {
  promoCode: unknown;
  membershipTypeNormalized: string;
  planNormalized: 'monthly' | 'annual';
  basePriceInCents: number;
}): Promise<PromoValidationOk | PromoValidationErr> {
  const promoCodeNormalized = digitsOnlyUpper(params.promoCode);
  if (!promoCodeNormalized) return { ok: false, code: 'PROMO_INVALID' };

  const promotion = await loadPromotionByCode(promoCodeNormalized);
  if (!promotion) return { ok: false, code: 'PROMO_INVALID' };

  const doc = promotion.data;
  if (!isPromoActive(doc)) return { ok: false, code: 'PROMO_INVALID' };

  const expiresAt = timestampToDate(doc.expirationDate ?? doc.expiresAt ?? doc.expiryDate);
  if (expiresAt && expiresAt.getTime() < Date.now()) return { ok: false, code: 'PROMO_EXPIRED' };

  if (!promoApplicableToMembership(doc, params.membershipTypeNormalized)) return { ok: false, code: 'PROMO_NOT_APPLICABLE' };
  if (!promoApplicableToPlan(doc, params.planNormalized)) return { ok: false, code: 'PROMO_NOT_APPLICABLE' };

  const discount = extractDiscount(doc);
  if (!discount) return { ok: false, code: 'PROMO_INVALID' };

  const basePriceInCents = params.basePriceInCents;
  const discountInCents =
    discount.type === 'percent' ? Math.round((basePriceInCents * discount.value) / 100) : discount.valueInCents;
  const finalPriceInCents = Math.max(0, basePriceInCents - discountInCents);
  const durationCycles = extractPromoDurationCycles(doc);

  return {
    ok: true,
    promoCodeNormalized,
    promotionId: promotion.id,
    discountType: discount.type === 'percent' ? 'percent' : 'amount',
    discountValue: discount.type === 'percent' ? discount.value : discount.valueInCents,
    discountInCents,
    basePriceInCents,
    finalPriceInCents,
    durationCycles,
    forEveryone: doc.forEveryone === true,
    membershipTypeNormalized: params.membershipTypeNormalized,
    planNormalized: params.planNormalized,
    expiresAt: expiresAt || null
  };
}

