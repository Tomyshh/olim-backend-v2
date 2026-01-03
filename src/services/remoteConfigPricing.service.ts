import { admin } from '../config/firebase.js';

type FamilyPricingNis = {
  ponctuallyNis: number;
  monthlyNis: number;
};

const DEFAULT_PONCTUALLY_NIS = 39;
const DEFAULT_MONTHLY_NIS = 69;

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let cache: { fetchedAtMs: number; pricing: FamilyPricingNis } | null = null;

function parseRemoteConfigNumber(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const n = Number(trimmed.replace(',', '.'));
  if (!Number.isFinite(n)) return null;
  if (n <= 0) return null;
  return n;
}

function getParamValue(template: any, key: string): string | null {
  const p = template?.parameters?.[key];
  const v = typeof p?.defaultValue?.value === 'string' ? p.defaultValue.value : null;
  if (v && v.trim()) return v.trim();
  // fallback: prendre la première conditionalValue non vide si la defaultValue n'existe pas
  const cond = p?.conditionalValues;
  if (cond && typeof cond === 'object') {
    for (const entry of Object.values(cond)) {
      const vv = typeof (entry as any)?.value === 'string' ? (entry as any).value : null;
      if (vv && vv.trim()) return vv.trim();
    }
  }
  return null;
}

export async function getFamilyMemberPricingNis(): Promise<FamilyPricingNis> {
  const now = Date.now();
  if (cache && now - cache.fetchedAtMs < CACHE_TTL_MS) return cache.pricing;

  let ponctuallyNis = DEFAULT_PONCTUALLY_NIS;
  let monthlyNis = DEFAULT_MONTHLY_NIS;

  try {
    const template = await admin.remoteConfig().getTemplate();

    const ponctuallyRaw = getParamValue(template, 'add_family_member_ponctually');
    const monthlyRaw = getParamValue(template, 'add_family_member_mensually');

    const p = parseRemoteConfigNumber(ponctuallyRaw);
    const m = parseRemoteConfigNumber(monthlyRaw);
    if (p != null) ponctuallyNis = p;
    if (m != null) monthlyNis = m;
  } catch (e: any) {
    // On ne bloque pas le backend si Remote Config est indisponible: fallback sur defaults
    console.error('Remote Config pricing: unable to fetch template, using defaults.', {
      message: e?.message || String(e)
    });
  }

  const pricing = { ponctuallyNis, monthlyNis };
  cache = { fetchedAtMs: now, pricing };
  return pricing;
}

export function nisToCents(amountNis: number): number {
  const n = Number(amountNis);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}


