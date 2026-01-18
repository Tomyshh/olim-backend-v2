import { admin } from '../config/firebase.js';

// Clé Remote Config (même nom que côté frontend)
const REMOTE_CONFIG_KEY = 'revolut_card_bins';

// Cache pour éviter de taper Remote Config à chaque requête
const CACHE_TTL_MS = Number(process.env.REVOLUT_CARD_BINS_CACHE_TTL_MS || 5 * 60 * 1000); // 5 min
let cache: { fetchedAtMs: number; bins: Set<string> } | null = null;

// Liste bootstrap (non exhaustive) - sert de fallback si Remote Config indisponible.
// NB: on stocke du BIN6 (6 premiers chiffres).
const BOOTSTRAP_BIN6 = new Set<string>(['404443', '416556', '535200']);

function parseBinsCsvToBin6Set(csv: unknown): Set<string> {
  const out = new Set<string>();
  if (typeof csv !== 'string') return out;
  for (const part of csv.split(',')) {
    const digits = part.trim().replace(/\D+/g, '');
    if (digits.length >= 6) out.add(digits.slice(0, 6));
  }
  return out;
}

function getEnvBins(): Set<string> {
  // Permet de surcharger rapidement sans Remote Config (ex: env var), format: "404443,416556"
  return parseBinsCsvToBin6Set(process.env.REVOLUT_CARD_BINS);
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

export async function getRevolutCardBin6Set(): Promise<Set<string>> {
  const now = Date.now();
  if (cache && now - cache.fetchedAtMs < CACHE_TTL_MS) return cache.bins;

  const bins = new Set<string>([...BOOTSTRAP_BIN6, ...getEnvBins()]);

  try {
    const template = await admin.remoteConfig().getTemplate();
    const raw = getParamValue(template, REMOTE_CONFIG_KEY);
    const remoteBins = parseBinsCsvToBin6Set(raw);
    for (const b of remoteBins) bins.add(b);
  } catch (e: any) {
    // On ne bloque pas le backend si Remote Config est indisponible
    console.error('Remote Config revolut_card_bins: unable to fetch template, using bootstrap/env.', {
      message: e?.message || String(e)
    });
  }

  cache = { fetchedAtMs: now, bins };
  return bins;
}

export async function isRevolutBin6(bin6: string | null | undefined): Promise<boolean> {
  const b = typeof bin6 === 'string' ? bin6.trim() : '';
  if (!/^\d{6}$/.test(b)) return false;
  const set = await getRevolutCardBin6Set();
  return set.has(b);
}

