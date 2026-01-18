import { admin } from '../config/firebase.js';

export type MembershipTypeNormalized = 'Pack Start' | 'Pack Essential' | 'Pack VIP' | 'Pack Elite';
export type PlanNormalized = 'monthly' | 'annual';

export type MembershipPricingResult = {
  ok: true;
  membershipTypeNormalized: MembershipTypeNormalized;
  planNormalized: PlanNormalized;
  serverPriceInCents: number;
  chargedPriceInCents: number;
  pricingSource: 'remote_config' | 'fallback' | 'client_price_validated';
  remoteConfigKeyUsed: string | null;
  remoteConfigValueNisUsed: number | null;
  clientPriceInCents: number | null;
};

export type MembershipPricingMismatch = {
  ok: false;
  code: 'PRICE_MISMATCH';
  membershipTypeNormalized: MembershipTypeNormalized;
  planNormalized: PlanNormalized;
  serverPriceInCents: number;
  clientPriceInCents: number;
  remoteConfigKeyUsed: string | null;
  remoteConfigValueNisUsed: number | null;
};

const CACHE_TTL_MS = Number(process.env.MEMBERSHIP_PRICING_CACHE_TTL_MS || 5 * 60 * 1000);
let cache: { fetchedAtMs: number; template: any } | null = null;

function pickString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function getParamValue(template: any, key: string): string | null {
  const p = template?.parameters?.[key];
  const v = typeof p?.defaultValue?.value === 'string' ? p.defaultValue.value : null;
  if (v && v.trim()) return v.trim();
  const cond = p?.conditionalValues;
  if (cond && typeof cond === 'object') {
    for (const entry of Object.values(cond)) {
      const vv = typeof (entry as any)?.value === 'string' ? (entry as any).value : null;
      if (vv && vv.trim()) return vv.trim();
    }
  }
  return null;
}

function parseStrictPositiveInt(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!/^[1-9]\d*$/.test(s)) return null; // >0
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function normalizeMembershipType(value: unknown): MembershipTypeNormalized | null {
  const raw = pickString(value);
  if (!raw) return null;
  const k = raw.toLowerCase().replace(/\s+/g, ' ').trim();

  if (k === 'pack start') return 'Pack Start';
  if (k === 'pack essential') return 'Pack Essential';
  if (k === 'pack vip') return 'Pack VIP';
  if (k === 'pack elite') return 'Pack Elite';

  return null;
}

export function normalizePlan(value: unknown): PlanNormalized | null {
  const s = pickString(value).toLowerCase();
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : NaN;

  if (s === 'monthly' || s === 'mensuel' || s === 'month' || s === 'mois') return 'monthly';
  if (s === 'annual' || s === 'annuel' || s === 'yearly' || s === 'an' || s === 'année') return 'annual';

  if (Number.isFinite(n)) {
    // compat: 1 => monthly, 12 => annual ; compat legacy interne: 3 => monthly, 4 => annual
    if (n === 1 || n === 3) return 'monthly';
    if (n === 12 || n === 4) return 'annual';
  }
  return null;
}

function getFallbackMonthlyNis(membership: MembershipTypeNormalized): number {
  switch (membership) {
    case 'Pack Start':
      return 149;
    case 'Pack Essential':
      return 249;
    case 'Pack VIP':
      return 399;
    case 'Pack Elite':
      return 990;
  }
}

function getFallbackNis(params: { membership: MembershipTypeNormalized; plan: PlanNormalized }): number {
  const monthly = getFallbackMonthlyNis(params.membership);
  // Heuristique “historique” observée: annuel = mensuel * 10 (ex: 249 -> 2490)
  return params.plan === 'annual' ? monthly * 10 : monthly;
}

function remoteConfigKeyFor(params: { membership: MembershipTypeNormalized; plan: PlanNormalized }): { primary: string; alternates: string[] } {
  const base =
    params.membership === 'Pack Start'
      ? 'pack_start'
      : params.membership === 'Pack Essential'
        ? 'pack_essential'
        : params.membership === 'Pack VIP'
          ? 'pack_vip'
          : 'pack_elite';

  if (params.plan === 'annual') {
    return { primary: `${base}_annually`, alternates: [] };
  }

  // Mensuel: typo historique à respecter côté app: pack_elite_mensualy (sans second "l")
  if (base === 'pack_elite') {
    return { primary: 'pack_elite_mensualy', alternates: ['pack_elite_mensually'] };
  }
  return { primary: `${base}_mensually`, alternates: [] };
}

async function getRemoteConfigTemplateCached(): Promise<any | null> {
  const now = Date.now();
  if (cache && now - cache.fetchedAtMs < CACHE_TTL_MS) return cache.template;
  try {
    const template = await admin.remoteConfig().getTemplate();
    cache = { fetchedAtMs: now, template };
    return template;
  } catch (e: any) {
    console.error('Remote Config membership pricing: unable to fetch template, using fallback.', {
      message: e?.message || String(e)
    });
    return null;
  }
}

export async function computeMembershipPricing(params: {
  membershipType: unknown;
  plan: unknown;
  clientPriceInCents?: unknown;
}): Promise<MembershipPricingResult | MembershipPricingMismatch | { ok: false; code: 'MEMBERSHIP_INVALID' | 'PLAN_INVALID' }> {
  const membershipTypeNormalized = normalizeMembershipType(params.membershipType);
  if (!membershipTypeNormalized) return { ok: false, code: 'MEMBERSHIP_INVALID' };

  const planNormalized = normalizePlan(params.plan);
  if (!planNormalized) return { ok: false, code: 'PLAN_INVALID' };

  const keyInfo = remoteConfigKeyFor({ membership: membershipTypeNormalized, plan: planNormalized });
  const template = await getRemoteConfigTemplateCached();

  let remoteConfigKeyUsed: string | null = null;
  let remoteConfigValueNisUsed: number | null = null;
  let pricingSource: 'remote_config' | 'fallback' = 'fallback';

  if (template) {
    const candidates = [keyInfo.primary, ...keyInfo.alternates];
    for (const k of candidates) {
      const raw = getParamValue(template, k);
      const nis = parseStrictPositiveInt(raw);
      if (nis != null) {
        remoteConfigKeyUsed = k;
        remoteConfigValueNisUsed = nis;
        pricingSource = 'remote_config';
        break;
      }
      // Même si la valeur est "0" / vide / invalide, on ne “devine” pas un autre pack.
      if (raw != null) remoteConfigKeyUsed = k; // utile pour debug même si invalide
    }
  }

  const fallbackNis = getFallbackNis({ membership: membershipTypeNormalized, plan: planNormalized });
  const nisUsed = remoteConfigValueNisUsed != null ? remoteConfigValueNisUsed : fallbackNis;
  const serverPriceInCents = nisUsed * 100;

  const clientRaw = typeof params.clientPriceInCents === 'number' ? params.clientPriceInCents : pickString(params.clientPriceInCents);
  const clientParsed =
    typeof clientRaw === 'number'
      ? clientRaw
      : typeof clientRaw === 'string' && clientRaw
        ? Number(clientRaw)
        : NaN;
  const clientPriceInCents =
    Number.isFinite(clientParsed) && clientParsed > 0 ? Math.floor(clientParsed) : null;

  if (clientPriceInCents != null && clientPriceInCents !== serverPriceInCents) {
    return {
      ok: false,
      code: 'PRICE_MISMATCH',
      membershipTypeNormalized,
      planNormalized,
      serverPriceInCents,
      clientPriceInCents,
      remoteConfigKeyUsed,
      remoteConfigValueNisUsed
    };
  }

  const chargedPriceInCents = clientPriceInCents != null ? clientPriceInCents : serverPriceInCents;
  const finalSource: MembershipPricingResult['pricingSource'] =
    clientPriceInCents != null ? 'client_price_validated' : pricingSource;

  return {
    ok: true,
    membershipTypeNormalized,
    planNormalized,
    serverPriceInCents,
    chargedPriceInCents,
    pricingSource: finalSource,
    remoteConfigKeyUsed,
    remoteConfigValueNisUsed,
    clientPriceInCents
  };
}

