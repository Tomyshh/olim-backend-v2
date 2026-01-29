import { config } from 'dotenv';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { paymeListSubscriptions, type PaymeSubscriptionListItem } from '../src/services/payme.service.js';

type Args = {
  out: string;
  amountIls: number;
  currency: string;
  limitEmails: number; // 0 = unlimited
  debugSaleCode: string;
};

function loadEnv(): void {
  const explicit = (process.env.DOTENV_CONFIG_PATH || '').trim();
  const candidates = [...(explicit ? [explicit] : []), '.env.local', '.env'];
  for (const rel of candidates) {
    const abs = resolve(process.cwd(), rel);
    if (!existsSync(abs)) continue;
    config({ path: abs });
    return;
  }
  config();
}

function parseArgs(argv: string[]): Args {
  const args: Args = { out: '', amountIls: 59, currency: 'ILS', limitEmails: 0, debugSaleCode: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') args.out = String(argv[i + 1] || '').trim();
    if (a === '--amount') {
      const n = Number(String(argv[i + 1] || '').trim());
      if (Number.isFinite(n) && n > 0) args.amountIls = n;
    }
    if (a === '--currency') args.currency = String(argv[i + 1] || '').trim().toUpperCase() || 'ILS';
    if (a === '--limitEmails') {
      const n = Number(String(argv[i + 1] || '').trim());
      args.limitEmails = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
    }
    if (a === '--debugSaleCode') args.debugSaleCode = String(argv[i + 1] || '').trim();
  }
  return args;
}

function pickString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeEmail(email: string): string {
  return pickString(email).toLowerCase();
}

function getPaymeBaseUrl(): string {
  const raw = (process.env.PAYME_BASE_URL || 'https://live.payme.io/api/').trim();
  return raw.replace(/\/+$/, '') + '/';
}

function requirePaymeSellerKey(): string {
  const key = process.env.PAYME_SELLER_KEY?.trim();
  if (!key) throw new Error('PAYME_SELLER_KEY manquant.');
  return key;
}

function assertHttps(url: string, label: string): void {
  if (!url.toLowerCase().startsWith('https://')) {
    throw new Error(`${label} doit être en HTTPS (TLS obligatoire).`);
  }
}

function paymeStatusCode(json: any): number | null {
  const v = json?.status_code ?? json?.statusCode ?? json?.status;
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

async function paymePostJson(path: string, body: unknown, timeoutMs: number): Promise<{ ok: boolean; status: number; json: any }> {
  const baseUrl = getPaymeBaseUrl();
  assertHttps(baseUrl, 'PAYME_BASE_URL');
  const url = new URL(path.replace(/^\/+/, ''), baseUrl).toString();
  assertHttps(url, 'PayMe URL');

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    const status = res.status;
    const text = await res.text();
    let json: any;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = {};
    }
    return { ok: res.ok, status, json };
  } finally {
    clearTimeout(t);
  }
}

type PaymeSaleItem = {
  email: string | null;
  description: string | null;
  salePaymeId: string | null;
  priceInCents: number | null;
  currency: string | null;
  status: string | number | null;
  createdAt: Date | null;
  createdAtIso: string | null;
  raw: any;
};

function parseDateLike(value: any): Date | null {
  if (!value) return null;
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    // < 1e12 -> seconds
    const ms = value < 1e12 ? value * 1000 : value;
    const d = new Date(ms);
    return Number.isFinite(d.getTime()) ? d : null;
  }
  if (typeof value === 'string' && value.trim()) {
    const s = value.trim();
    const n = Number(s);
    if (Number.isFinite(n)) return parseDateLike(n);
    const d = new Date(s);
    return Number.isFinite(d.getTime()) ? d : null;
  }
  return null;
}

function formatIso(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

/**
 * Normalise un montant PayMe en agorot (cents ILS).
 * PayMe peut renvoyer:
 * - "59.00" (ILS) => 5900
 * - "59" => 5900 (heuristique)
 * - "5900" => 5900
 */
function parsePaymePriceToAgorot(value: any): number | null {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const n = value;
    // Heuristique: si >=1000 => agorot; sinon shekels
    return n >= 1000 ? Math.round(n) : Math.round(n * 100);
  }
  if (typeof value === 'string' && value.trim()) {
    const s = value.trim();
    if (s.includes('.')) {
      const f = Number(s);
      return Number.isFinite(f) ? Math.round(f * 100) : null;
    }
    const n = Number(s);
    if (!Number.isFinite(n)) return null;
    return n >= 1000 ? Math.round(n) : Math.round(n * 100);
  }
  return null;
}

function pickSaleEmail(item: any): string {
  return (
    pickString(item?.sale_email) ||
    pickString(item?.buyer_email) ||
    pickString(item?.email) ||
    pickString(item?.buyer?.email) ||
    pickString(item?.sale?.email) ||
    pickString(item?.buyer_details?.buyer_email) ||
    pickString(item?.buyer_details?.email) ||
    pickString(item?.sale_buyer_details?.buyer_email) ||
    pickString(item?.sale_buyer_details?.email) ||
    ''
  );
}

function pickSaleDescription(item: any): string {
  return (
    pickString(item?.product_name) ||
    pickString(item?.sale_product_name) ||
    pickString(item?.sale_description) ||
    pickString(item?.description) ||
    pickString(item?.sale?.product_name) ||
    pickString(item?.sale?.description) ||
    ''
  );
}

function pickSalePaymeId(item: any): string {
  return (
    pickString(item?.payme_sale_id) ||
    pickString(item?.sale_payme_id) ||
    pickString(item?.sale_id) ||
    pickString(item?.id) ||
    pickString(item?.sale?.payme_sale_id) ||
    ''
  );
}

function pickSaleStatus(item: any): string | number | null {
  const v = item?.sale_status ?? item?.status ?? item?.saleStatus ?? null;
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return null;
}

function pickSaleCreatedAt(item: any): Date | null {
  return (
    parseDateLike(item?.sale_date) ||
    parseDateLike(item?.saleDate) ||
    parseDateLike(item?.created_at) ||
    parseDateLike(item?.createdAt) ||
    parseDateLike(item?.timestamp) ||
    parseDateLike(item?.sale?.sale_date) ||
    parseDateLike(item?.sale_created) ||
    parseDateLike(item?.sale_paid_date) ||
    null
  );
}

function pickSaleAmountRaw(item: any): unknown {
  return (
    item?.transaction_first_payment ??
    item?.transactionFirstPayment ??
    item?.transaction_periodical_payment ??
    item?.transactionPeriodicalPayment ??
    item?.sale_price ??
    item?.salePrice ??
    item?.sale_price_after_fees ??
    item?.salePriceAfterFees ??
    item?.price ??
    item?.amount ??
    item?.sale?.sale_price ??
    null
  );
}

function pickItemsFromResponse(json: any): any[] {
  const direct = Array.isArray(json?.items) ? json.items : null;
  if (direct) return direct;
  const dataItems = Array.isArray(json?.data?.items) ? json.data.items : null;
  if (dataItems) return dataItems;
  const list = Array.isArray(json?.list) ? json.list : null;
  if (list) return list;
  return [];
}

async function paymeListSales(): Promise<{ items: PaymeSaleItem[]; usedEndpoints: string[] }> {
  const seller_payme_id = requirePaymeSellerKey();

  const endpoints = [
    'get-sales',
    'get-transactions',
    'get-payments',
    'get-receipts',
    'receipts-get'
  ];

  const allMapped: PaymeSaleItem[] = [];
  const used: string[] = [];
  const seen = new Set<string>(); // key=endpoint:saleId:email:date
  let lastErr: any = null;

  for (const ep of endpoints) {
    try {
      const timeoutMs = 30000;
      async function fetchItems(extraBody: Record<string, unknown>): Promise<any[]> {
        const { ok, status, json } = await paymePostJson(ep, { seller_payme_id, ...(extraBody || {}) }, timeoutMs);
        if (!ok || status < 200 || status >= 300) return [];

        const code = paymeStatusCode(json);
        if (code != null && code !== 0) return [];

        const rawItems = pickItemsFromResponse(json);
        return Array.isArray(rawItems) ? rawItems : [];
      }

      const first = await fetchItems({});
      if (!first || first.length === 0) continue;

      const allRaw: any[] = [...first];
      const uniqKey = (it: any): string => pickSalePaymeId(it) || JSON.stringify([pickSaleEmail(it) || '', pickSaleCreatedAt(it)?.toISOString() || '']);
      const seen = new Set<string>();
      for (const it of first) seen.add(uniqKey(it));

      // Pagination heuristique: si 500 items => on tente d'autres pages
      const pageSize = first.length;
      const shouldTryPaging = pageSize >= 500;
      const maxPagesRaw = Number(process.env.PAYME_LIST_SALES_MAX_PAGES || 20);
      const maxPages = Number.isFinite(maxPagesRaw) && maxPagesRaw > 0 ? Math.floor(maxPagesRaw) : 20;

      type Pager = { name: string; make: (page: number) => Record<string, unknown> };
      const pagers: Pager[] = [
        { name: 'page/page_size', make: (page) => ({ page, page_size: pageSize }) },
        { name: 'pageNumber/pageSize', make: (page) => ({ pageNumber: page, pageSize }) },
        { name: 'page_number/page_size', make: (page) => ({ page_number: page, page_size: pageSize }) },
        { name: 'offset/limit', make: (page) => ({ offset: (page - 1) * pageSize, limit: pageSize }) }
      ];

      if (shouldTryPaging) {
        let chosen: Pager | null = null;
        for (const p of pagers) {
          const page2 = await fetchItems(p.make(2));
          const hasNew = page2.some((it) => !seen.has(uniqKey(it)));
          if (page2.length > 0 && hasNew) {
            chosen = p;
            for (const it of page2) {
              const k = uniqKey(it);
              if (seen.has(k)) continue;
              seen.add(k);
              allRaw.push(it);
            }
            break;
          }
        }

        if (chosen) {
          for (let page = 3; page <= maxPages; page++) {
            const items = await fetchItems(chosen.make(page));
            if (items.length === 0) break;
            let added = 0;
            for (const it of items) {
              const k = uniqKey(it);
              if (seen.has(k)) continue;
              seen.add(k);
              allRaw.push(it);
              added++;
            }
            if (added === 0) break;
            if (items.length < pageSize) break;
          }
        }
      }

      const mapped: PaymeSaleItem[] = allRaw.map((it: any) => {
        const email = normalizeEmail(pickSaleEmail(it)) || null;
        const description = pickSaleDescription(it) || null;
        const salePaymeId = pickSalePaymeId(it) || null;
        const createdAt = pickSaleCreatedAt(it);
        const priceInCents = parsePaymePriceToAgorot(pickSaleAmountRaw(it));
        const currency = pickString(it?.currency ?? it?.sale_currency ?? it?.sale?.currency ?? '') || null;
        const statusVal = pickSaleStatus(it);
        return {
          email,
          description,
          salePaymeId,
          priceInCents,
          currency,
          status: statusVal,
          createdAt,
          createdAtIso: formatIso(createdAt),
          raw: it
        };
      });

      used.push(ep);
      for (const m of mapped) {
        const key = `${ep}:${m.salePaymeId || ''}:${m.email || ''}:${m.createdAtIso || ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        allMapped.push(m);
      }
    } catch (e: any) {
      lastErr = e;
    }
  }

  if (allMapped.length === 0) {
    throw new Error(
      `Impossible de lister les ventes PayMe (endpoints testés: ${endpoints.join(', ')}). Dernière erreur: ${String(lastErr?.message || lastErr)}`
    );
  }

  return { items: allMapped, usedEndpoints: used };
}

function pickMostRelevantCurrentSubscription(subs: PaymeSubscriptionListItem[]): PaymeSubscriptionListItem | null {
  if (!subs || subs.length === 0) return null;
  const active = subs.filter((s) => s.subStatus === 2);
  const pool = active.length > 0 ? active : subs;

  const score = (s: PaymeSubscriptionListItem): number => {
    const created = (() => {
      const raw = s?.raw?.sub_created ?? null;
      const d = parseDateLike(raw);
      return d ? d.getTime() : 0;
    })();
    if (created) return created;
    const d = s.nextPaymentDate || s.startDate || null;
    return d ? d.getTime() : 0;
  };

  return [...pool].sort((a, b) => score(b) - score(a))[0]!;
}

function reportPathDefault(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return resolve(process.cwd(), 'tmp', `payme-activation-service-${stamp}.md`);
}

function toMd(params: {
  generatedAtIso: string;
  amountIls: number;
  currency: string;
  usedSalesEndpoint: string;
  matchingEmails: Array<{
    email: string;
    sales: PaymeSaleItem[];
    currentSubscription: { description: string | null; subCode: string | null; status: number | null } | null;
  }>;
}): string {
  const lines: string[] = [];
  lines.push('# Rapport PayMe — ventes filtrées par montant');
  lines.push('');
  lines.push(`- Généré: ${params.generatedAtIso}`);
  lines.push(`- Filtre: montant = ${params.amountIls.toFixed(2)} ${params.currency}`);
  lines.push(`- Endpoint ventes utilisé: ${params.usedSalesEndpoint}`);
  lines.push(`- Emails trouvés: ${params.matchingEmails.length}`);
  lines.push('');

  for (const row of params.matchingEmails) {
    lines.push(`## ${row.email}`);
    if (row.currentSubscription) {
      lines.push(`- Abonnement actuel (PayMe): ${row.currentSubscription.description || '(vide)'} | subCode=${row.currentSubscription.subCode || '(vide)'} | status=${row.currentSubscription.status ?? '(vide)'}`);
    } else {
      lines.push('- Abonnement actuel (PayMe): (introuvable)');
    }
    lines.push('');
    lines.push('| Date | Transaction | Description | Montant | Statut |');
    lines.push('|---|---|---|---:|---|');
    for (const s of row.sales.sort((a, b) => String(b.createdAtIso || '').localeCompare(String(a.createdAtIso || '')))) {
      const amount =
        s.priceInCents != null ? `${(s.priceInCents / 100).toFixed(2)} ${s.currency || ''}`.trim() : '';
      lines.push(`| ${s.createdAtIso || ''} | ${s.salePaymeId || ''} | ${(s.description || '').replaceAll('|', '\\|')} | ${amount} | ${s.status ?? ''} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

async function main(): Promise<void> {
  loadEnv();
  const args = parseArgs(process.argv.slice(2));
  const amountIls = Number.isFinite(args.amountIls) ? args.amountIls : 59;
  const currency = (args.currency || 'ILS').toUpperCase();
  const targetCents = Math.round(amountIls * 100);

  console.log('🔎 Script (LECTURE SEULE): PayMe sales + subscriptions, filtre par montant');
  console.log('Filtre', { amountIls, currency });

  // 1) Subscriptions (pour l'abonnement actuel par email)
  console.log('⏳ Chargement subscriptions PayMe…');
  const subscriptions = await paymeListSubscriptions();
  const subsByEmail = new Map<string, PaymeSubscriptionListItem[]>();
  for (const s of subscriptions) {
    const email = s.email ? normalizeEmail(s.email) : '';
    if (!email) continue;
    const arr = subsByEmail.get(email) || [];
    arr.push(s);
    subsByEmail.set(email, arr);
  }

  // 2) Sales/transactions
  console.log('⏳ Chargement ventes PayMe…');
  const { items: sales, usedEndpoints } = await paymeListSales();
  console.log('Infos ventes', {
    usedEndpoints,
    totalSales: sales.length,
    sampleDescription: sales[0]?.description ?? null
  });

  const DEBUG = process.env.PAYME_REPORT_DEBUG === 'true';

  if (DEBUG && args.debugSaleCode) {
    const code = args.debugSaleCode;
    const hit = sales.find((s) => String(s.raw?.sale_payme_code ?? '') === code);
    console.log('Debug sale_payme_code', {
      requested: code,
      found: Boolean(hit),
      foundFields: hit
        ? {
            sale_payme_code: hit.raw?.sale_payme_code ?? null,
            sale_description: hit.raw?.sale_description ?? null,
            sale_currency: hit.raw?.sale_currency ?? null,
            sale_price: hit.raw?.sale_price ?? null,
            transaction_first_payment: hit.raw?.transaction_first_payment ?? null,
            transaction_periodical_payment: hit.raw?.transaction_periodical_payment ?? null,
            sale_buyer_details: hit.raw?.sale_buyer_details ?? null
          }
        : null
    });
  }
  if (DEBUG && sales.length > 0) {
    const r0 = sales[0]!.raw || {};
    console.log('Debug sale[0] raw keys', Object.keys(r0));
    console.log('Debug sale[0] amount candidates', {
      sale_price: (r0 as any)?.sale_price ?? null,
      transaction_first_payment: (r0 as any)?.transaction_first_payment ?? null,
      transaction_periodical_payment: (r0 as any)?.transaction_periodical_payment ?? null,
      price: (r0 as any)?.price ?? null,
      amount: (r0 as any)?.amount ?? null,
      sale_sale_price: (r0 as any)?.sale?.sale_price ?? null,
      sale_price_keys: (r0 as any)?.sale ? Object.keys((r0 as any).sale) : null
    });
  }

  // 3) Filtre
  const salesByEmail = new Map<string, PaymeSaleItem[]>();
  const debugPriceDist: Record<string, number> = {};
  let debugAmountMatchesAny = 0;
  let debugAmountMatchesWithEmail = 0;
  let debugSampleAmountMatch: any = null;
  for (const sale of sales) {
    const ccy = (sale.currency || '').toUpperCase();
    if (currency && ccy && ccy !== currency) continue;
    if (sale.priceInCents == null) continue;
    debugPriceDist[String(sale.priceInCents)] = (debugPriceDist[String(sale.priceInCents)] || 0) + 1;
    if (sale.priceInCents !== targetCents) continue;

    debugAmountMatchesAny++;
    if (!debugSampleAmountMatch) debugSampleAmountMatch = sale.raw;

    const email = sale.email ? normalizeEmail(sale.email) : '';
    if (!email) continue;
    debugAmountMatchesWithEmail++;
    const arr = salesByEmail.get(email) || [];
    arr.push(sale);
    salesByEmail.set(email, arr);
  }
  // Debug rapide: voir si 5900 apparaît bien dans les ventes
  if (DEBUG) {
    const top = Object.entries(debugPriceDist)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([k, v]) => ({ agorot: k, count: v, ils: (Number(k) / 100).toFixed(2) }));
    console.log('Debug montants (top10)', top);
    console.log('Debug cible', { targetCents, targetIls: (targetCents / 100).toFixed(2) });
    console.log('Debug matches', {
      amountMatchesAny: debugAmountMatchesAny,
      amountMatchesWithEmail: debugAmountMatchesWithEmail,
      sampleMatchKeys: debugSampleAmountMatch ? Object.keys(debugSampleAmountMatch) : null
    });
  }

  const emails = Array.from(salesByEmail.keys()).sort((a, b) => a.localeCompare(b));
  const limited = args.limitEmails > 0 ? emails.slice(0, args.limitEmails) : emails;

  const rows = limited.map((email) => {
    const subs = subsByEmail.get(email) || [];
    const current = pickMostRelevantCurrentSubscription(subs);
    return {
      email,
      sales: salesByEmail.get(email) || [],
      currentSubscription: current
        ? {
            description: current.description,
            subCode: current.subCode != null ? String(current.subCode) : null,
            status: current.subStatus
          }
        : null
    };
  });

  const outPath = args.out ? resolve(process.cwd(), args.out) : reportPathDefault();
  mkdirSync(resolve(outPath, '..'), { recursive: true });
  const md = toMd({
    generatedAtIso: new Date().toISOString(),
    amountIls,
    currency,
    usedSalesEndpoint: usedEndpoints.join(', ') || '(unknown)',
    matchingEmails: rows
  });
  writeFileSync(outPath, md, 'utf8');

  console.log('✅ Rapport écrit:', outPath);
  console.log('Résumé', { emails: rows.length, totalMatchingSales: rows.reduce((acc, r) => acc + r.sales.length, 0) });
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('❌ Erreur:', e?.message || String(e));
    process.exit(1);
  });

