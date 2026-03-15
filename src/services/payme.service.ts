import { HttpError } from '../utils/errors.js';
import { runWithConcurrencyLimit } from './concurrencyLimit.service.js';
import { getOrSetJsonWithLock } from './cache.service.js';

type PaymeCaptureBuyerTokenResult = {
  buyerKey: string;
  buyerCard: string;
  buyerName?: string;
};

type PaymeSubscriptionResult = {
  subCode: number | string;
  subID: string;
};

export type PaymeSubscriptionDetails = {
  subCode: number | string;
  subStatus: number | null;
  /**
   * Date de prochain prélèvement / fin de période renvoyée par PayMe (normalisée).
   * - nextPaymentDate: Date (timezone locale, 12:00 pour éviter DST)
   * - nextPaymentDateYmd: string "YYYY-MM-DD" (format stable pour front)
   */
  nextPaymentDate: Date | null;
  nextPaymentDateYmd: string | null;
  raw?: any;
};

export type PaymeSubscriptionListItem = {
  subCode: number | string | null;
  subStatus: number | null;
  email: string | null;
  description: string | null;
  subId: string | null;
  iterationType: number | null;
  nextPaymentDate: Date | null;
  nextPaymentDateYmd: string | null;
  lastPaymentDate: Date | null;
  lastPaymentDateYmd: string | null;
  startDate: Date | null;
  startDateYmd: string | null;
  raw: any;
};

function getPaymeBaseUrl(): string {
  const raw = (process.env.PAYME_BASE_URL || 'https://live.payme.io/api/').trim();
  return raw.replace(/\/+$/, '') + '/';
}

function requirePaymeSellerKey(): string {
  const key = process.env.PAYME_SELLER_KEY?.trim();
  if (!key) throw new HttpError(500, 'Configuration paiement manquante (PAYME_SELLER_KEY).');
  return key;
}

function assertHttps(url: string, label: string): void {
  if (!url.toLowerCase().startsWith('https://')) {
    throw new HttpError(500, `${label} doit être en HTTPS (TLS obligatoire).`);
  }
}

function normalizeCardNumberDigitsOnly(value: unknown): string {
  const raw = typeof value === 'string' ? value : '';
  return raw.replace(/\D+/g, '');
}

function safePaymeErrorMessage(json: any): string {
  const details = typeof json?.status_error_details === 'string' ? json.status_error_details : '';
  return details || 'Erreur PayMe.';
}

function attachPaymeDetails(err: any, details: Record<string, any>): void {
  // Ne jamais inclure de données carte ici.
  (err as any).payme = {
    ...(typeof (err as any).payme === 'object' && (err as any).payme ? (err as any).payme : {}),
    ...details
  };
}

function paymeStatusCode(json: any): number | null {
  const v = json?.status_code ?? json?.statusCode ?? json?.status;
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

function assertPaymeStatusCodeOk(json: any, prefix: string): void {
  const code = paymeStatusCode(json);
  // PayMe: 0 = success (souvent), sinon échec même si HTTP 200
  if (code != null && code !== 0) {
    throw new HttpError(400, `${prefix}: ${safePaymeErrorMessage(json)}`, 'PAYME_STATUS_NOT_OK');
  }
}

function pickFirstString(obj: any, keys: string[]): string {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

async function paymePostJson(path: string, body: unknown, timeoutMs: number): Promise<{ ok: boolean; status: number; json: any }> {
  return paymeRequestJson('POST', path, body, timeoutMs);
}

async function paymePatchJson(path: string, body: unknown, timeoutMs: number): Promise<{ ok: boolean; status: number; json: any }> {
  return paymeRequestJson('PATCH', path, body, timeoutMs);
}

async function paymeRequestJson(
  method: 'POST' | 'PATCH',
  path: string,
  body: unknown,
  timeoutMs: number
): Promise<{ ok: boolean; status: number; json: any }> {
  const baseUrl = getPaymeBaseUrl();
  assertHttps(baseUrl, 'PAYME_BASE_URL');

  const url = new URL(path.replace(/^\/+/, ''), baseUrl).toString();
  assertHttps(url, 'PayMe URL');

  try {
    const limit = Number(process.env.PAYME_CONCURRENCY || 5);
    const waitTimeoutMs = Number(process.env.PAYME_WAIT_TIMEOUT_MS || 5000);

    const res = await runWithConcurrencyLimit({
      key: 'payme',
      limit: Number.isFinite(limit) && limit > 0 ? limit : 5,
      waitTimeoutMs: Number.isFinite(waitTimeoutMs) && waitTimeoutMs > 0 ? waitTimeoutMs : 5000,
      // IMPORTANT:
      // Le timeout doit démarrer quand la requête réseau démarre réellement, pas avant.
      // Sinon on “mange” du timeout pendant l’attente de concurrence (queue), et on obtient des faux timeouts.
      fn: async () => {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
          return await fetch(url, {
            method,
            headers: {
              Accept: 'application/json',
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(body),
            signal: ctrl.signal
          });
        } finally {
          clearTimeout(t);
        }
      }
    });
    const status = res.status;
    const text = await res.text();
    let json: any;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      console.error(`PayMe ${path}: réponse non-JSON. Status: ${status}, Text:`, text.substring(0, 200));
      json = {};
    }
    return { ok: res.ok, status, json };
  } catch (e: any) {
    if (e?.name === 'ConcurrencyLimitError') {
      throw new HttpError(503, 'Service paiement surchargé. Veuillez réessayer.', 'PAYME_OVERLOADED');
    }
    if (e?.name === 'AbortError') {
      console.warn('[PayMe] Timeout', { path, timeoutMs });
      throw new HttpError(504, 'Le service de paiement ne répond pas. Veuillez réessayer dans quelques instants.', 'PAYME_TIMEOUT');
    }
    const err = new HttpError(502, 'Le service de paiement est indisponible. Veuillez réessayer.', 'PAYME_UPSTREAM_ERROR');
    attachPaymeDetails(err, { path, method });
    throw err;
  }
}

function coerceSubCode(value: unknown): number | string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const trimmed = value.trim();
    const n = Number(trimmed);
    if (Number.isFinite(n) && String(n) === trimmed) return n;
    return trimmed;
  }
  return null;
}

function pickSubStatusFromGetSubscriptionsResponse(json: any, subCode: number | string): number | null {
  const items = Array.isArray(json?.items) ? (json.items as any[]) : null;
  const first = items && items.length > 0 ? items[0] : null;

  // Priorité: item correspondant au code demandé
  const match =
    items?.find((it) => {
      const code = it?.sub_payme_code ?? it?.subCode ?? it?.sub_code;
      const coerced = coerceSubCode(code);
      return coerced != null && String(coerced) === String(subCode);
    }) ?? first;

  // PayMe peut renvoyer soit `status` soit `sub_status` selon endpoint/version.
  const raw = match?.status ?? match?.sub_status ?? match?.subStatus ?? json?.status ?? json?.sub_status ?? json?.subStatus;
  const n = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : NaN;
  return Number.isFinite(n) ? n : null;
}

function pickSubNextDateFromGetSubscriptionsResponse(json: any, subCode: number | string): unknown {
  const items = Array.isArray(json?.items) ? (json.items as any[]) : null;
  const first = items && items.length > 0 ? items[0] : null;
  const match =
    items?.find((it) => {
      const code = it?.sub_payme_code ?? it?.subCode ?? it?.sub_code;
      const coerced = coerceSubCode(code);
      return coerced != null && String(coerced) === String(subCode);
    }) ?? first;

  // Clés observées / probables
  return (
    match?.sub_next_date ??
    match?.subNextDate ??
    match?.next_payment_date ??
    match?.nextPaymentDate ??
    json?.sub_next_date ??
    json?.subNextDate ??
    json?.next_payment_date ??
    json?.nextPaymentDate ??
    null
  );
}

function parseDdMmYyyyToDate(value: string): Date | null {
  const m = String(value || '').trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  const dd = Number(m[1]);
  const mm = Number(m[2]);
  const yyyy = Number(m[3]);
  if (!Number.isFinite(dd) || !Number.isFinite(mm) || !Number.isFinite(yyyy)) return null;
  // Noon local time to avoid DST edge cases
  return new Date(yyyy, mm - 1, dd, 12, 0, 0, 0);
}

function parseYyyyMmDdToDate(value: string): Date | null {
  const m = String(value || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const yyyy = Number(m[1]);
  const mm = Number(m[2]);
  const dd = Number(m[3]);
  if (!Number.isFinite(dd) || !Number.isFinite(mm) || !Number.isFinite(yyyy)) return null;
  return new Date(yyyy, mm - 1, dd, 12, 0, 0, 0);
}

function formatYyyyMmDd(d: Date): string {
  const yyyy = String(d.getFullYear());
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function normalizePaymeNextPaymentDate(value: unknown): { date: Date | null; ymd: string | null } {
  if (!value) return { date: null, ymd: null };
  if (value instanceof Date && !Number.isNaN(value.getTime())) return { date: value, ymd: formatYyyyMmDd(value) };
  if (typeof value === 'string') {
    const s = value.trim();
    if (!s) return { date: null, ymd: null };
    const d1 = parseYyyyMmDdToDate(s);
    if (d1) return { date: d1, ymd: formatYyyyMmDd(d1) };
    const d2 = parseDdMmYyyyToDate(s);
    if (d2) return { date: d2, ymd: formatYyyyMmDd(d2) };
    const d3 = new Date(s);
    if (!Number.isNaN(d3.getTime())) return { date: d3, ymd: formatYyyyMmDd(d3) };
  }
  // Support timestamp-like
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (Number.isFinite(n) && n > 0) {
    const d = new Date(n);
    if (!Number.isNaN(d.getTime())) return { date: d, ymd: formatYyyyMmDd(d) };
  }
  return { date: null, ymd: null };
}

function pickArray(json: any, keys: string[]): any[] {
  for (const k of keys) {
    const v = json?.[k];
    if (Array.isArray(v)) return v;
  }
  return [];
}

function pickSubscriptionEmail(item: any): string {
  return (
    pickFirstString(item, ['sale_email', 'buyer_email', 'email', 'customer_email', 'client_email']) ||
    pickFirstString(item?.sale, ['email']) ||
    pickFirstString(item?.buyer, ['email']) ||
    pickFirstString(item?.sub_buyer_details, ['buyer_email', 'email', 'mail']) ||
    ''
  );
}

function pickSubscriptionDescription(item: any): string {
  return (
    pickFirstString(item, ['sub_description', 'description', 'product_name', 'plan_name', 'membership']) ||
    pickFirstString(item?.sale, ['product_name', 'description']) ||
    ''
  );
}

function pickSubscriptionStartDateRaw(item: any): unknown {
  return item?.sub_start_date ?? item?.subStartDate ?? item?.start_date ?? item?.startDate ?? null;
}

/**
 * PayMe: POST /api/get-subscriptions
 * Body: { seller_payme_id, sub_payme_code }
 * Retour: items[] avec sub_status (statut abonnement)
 */
export async function paymeGetSubscriptionDetails(params: {
  subCode: number | string;
  /**
   * Optionnel: si vous avez plusieurs sellers. Par défaut: PAYME_SELLER_KEY
   */
  sellerPaymeId?: string;
}): Promise<PaymeSubscriptionDetails | null> {
  const subCode = coerceSubCode(params.subCode);
  if (subCode == null) return null;

  const seller_payme_id = (params.sellerPaymeId || requirePaymeSellerKey()).trim();
  if (!seller_payme_id) return null;

  const cacheKey = `payme:get-subscriptions:${seller_payme_id}:${String(subCode)}`;
  const ttlSeconds = Number(process.env.PAYME_SUBSCRIPTION_STATUS_TTL_SECONDS || 300);

  const { value } = await getOrSetJsonWithLock({
    key: cacheKey,
    ttlSeconds: Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? ttlSeconds : 300,
    lockTtlSeconds: 15,
    waitScheduleMs: [150, 250, 400],
    fn: async () => {
      const { ok, status, json } = await paymePostJson(
        'get-subscriptions',
        {
          seller_payme_id,
          sub_payme_code: subCode
        },
        12000
      );

      // PayMe peut renvoyer HTTP 200 même en échec logique
      if (!ok || status < 200 || status >= 300) {
        return { ok: false, status, json };
      }
      return { ok: true, status, json };
    }
  });

  if (!value?.ok) return null;

  const subStatus = pickSubStatusFromGetSubscriptionsResponse(value.json, subCode);
  const nextRaw = pickSubNextDateFromGetSubscriptionsResponse(value.json, subCode);
  const normalizedNext = normalizePaymeNextPaymentDate(nextRaw);
  return {
    subCode,
    subStatus,
    nextPaymentDate: normalizedNext.date,
    nextPaymentDateYmd: normalizedNext.ymd,
    raw: value.json
  };
}

export async function paymeGetSubscriptionStatus(subCode: number | string): Promise<number | null> {
  const details = await paymeGetSubscriptionDetails({ subCode });
  return details?.subStatus ?? null;
}

/**
 * PayMe: liste des subscriptions du marchand
 * Body minimal: { seller_payme_id }
 *
 * IMPORTANT:
 * - PayMe n'est pas toujours stable côté schéma; on renvoie un mapping robuste + `raw`.
 * - Si PayMe ne supporte pas le listing sans `sub_payme_code`, la fonction renverra [].
 */
export async function paymeListSubscriptions(params?: { sellerPaymeId?: string }): Promise<PaymeSubscriptionListItem[]> {
  const seller_payme_id = (params?.sellerPaymeId || requirePaymeSellerKey()).trim();
  if (!seller_payme_id) return [];

  const timeoutMs = 20000;

  async function fetchItems(extraBody: Record<string, unknown>): Promise<any[]> {
    const { ok, status, json } = await paymePostJson(
      'get-subscriptions',
      {
        seller_payme_id,
        // NOTE: on N'ENVOIE PAS sub_payme_code pour tenter d'obtenir la liste complète
        ...(extraBody || {})
      },
      timeoutMs
    );
    if (!ok || status < 200 || status >= 300) return [];
    const items = pickArray(json, ['items']) || pickArray(json?.data, ['items']) || [];
    return Array.isArray(items) ? items : [];
  }

  const first = await fetchItems({});
  if (first.length === 0) return [];

  const allRaw: any[] = [...first];
  const seen = new Set<string>();
  const uniqKey = (it: any): string =>
    String(it?.sub_payme_id ?? it?.sub_payme_code ?? it?.subscription_id ?? JSON.stringify([it?.seller_id ?? '', it?.sub_created ?? '']));
  for (const it of first) seen.add(uniqKey(it));

  // Heuristique: PayMe semble renvoyer 500 items/page (observé en prod). Si on a exactement 500, on tente une pagination.
  const pageSize = first.length;
  const shouldTryPaging = pageSize >= 500;
  const maxPagesRaw = Number(process.env.PAYME_LIST_SUBSCRIPTIONS_MAX_PAGES || 20);
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

    // Détecter un schéma de pagination qui marche (page 2 apporte de nouveaux items)
    for (const p of pagers) {
      const page2 = await fetchItems(p.make(2));
      const hasNew = page2.some((it) => !seen.has(uniqKey(it)));
      if (page2.length > 0 && hasNew) {
        chosen = p;
        // Ajouter page2
        for (const it of page2) {
          const k = uniqKey(it);
          if (seen.has(k)) continue;
          seen.add(k);
          allRaw.push(it);
        }
        break;
      }
    }

    // Paginer avec le schéma trouvé
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
        // Si une page n'apporte rien de nouveau, on stop (évite boucle infinie si PayMe ignore la pagination).
        if (added === 0) break;
        // Si PayMe renvoie moins qu'une page, c'est probablement la fin.
        if (items.length < pageSize) break;
      }
    }
  }

  return allRaw.map((it) => {
    const subCodeRaw = it?.sub_payme_code ?? it?.subCode ?? it?.sub_code ?? null;
    const subCode = coerceSubCode(subCodeRaw);
    // PayMe dashboard/export: `status` (2=actif, 5=annulé). API: parfois `sub_status`.
    const rawStatus = it?.status ?? it?.sub_status ?? it?.subStatus ?? null;
    const subStatus =
      typeof rawStatus === 'string' ? Number(rawStatus) : typeof rawStatus === 'number' ? rawStatus : NaN;

    const nextRaw =
      it?.sub_next_date ??
      it?.subNextDate ??
      it?.next_payment_date ??
      it?.nextPaymentDate ??
      it?.next_date ??
      null;
    const next = normalizePaymeNextPaymentDate(nextRaw);

    // Dernier paiement: PayMe renvoie souvent sub_payment_date (ou sub_prev_date selon contextes).
    const lastRaw = it?.sub_payment_date ?? it?.subPaymentDate ?? it?.sub_prev_date ?? it?.subPrevDate ?? null;
    const last = normalizePaymeNextPaymentDate(lastRaw);

    const start = normalizePaymeNextPaymentDate(pickSubscriptionStartDateRaw(it));

    const email = pickSubscriptionEmail(it) || null;
    const description = pickSubscriptionDescription(it) || null;

    const subIdRaw = it?.sub_payme_id ?? it?.subscription_id ?? it?.subID ?? it?.subId ?? null;
    const subId = typeof subIdRaw === 'string' && subIdRaw.trim() ? subIdRaw.trim() : null;

    const itRaw = it?.sub_iteration_type ?? it?.subIterationType ?? null;
    const iterationType =
      typeof itRaw === 'string' ? Number(itRaw.trim()) : typeof itRaw === 'number' ? itRaw : NaN;

    return {
      subCode,
      subStatus: Number.isFinite(subStatus) ? subStatus : null,
      email,
      description,
      subId,
      iterationType: Number.isFinite(iterationType) ? iterationType : null,
      nextPaymentDate: next.date,
      nextPaymentDateYmd: next.ymd,
      lastPaymentDate: last.date,
      lastPaymentDateYmd: last.ymd,
      startDate: start.date,
      startDateYmd: start.ymd,
      raw: it
    };
  });
}

export async function paymeCaptureBuyerToken(params: {
  email: string;
  buyerName: string;
  cardHolder?: string;
  cardNumber: unknown;
  expirationDate: unknown; // MM/YY
  cvv: unknown;
  buyerZipCode?: unknown; // requis uniquement pour certains émetteurs (ex: Revolut)
}): Promise<PaymeCaptureBuyerTokenResult> {
  const seller_payme_id = requirePaymeSellerKey();

  const credit_card_number = normalizeCardNumberDigitsOnly(params.cardNumber);
  const credit_card_exp = typeof params.expirationDate === 'string' ? params.expirationDate.trim() : '';
  const credit_card_cvv = typeof params.cvv === 'string' ? params.cvv.trim() : '';
  const buyer_zip_code = typeof params.buyerZipCode === 'string' ? params.buyerZipCode.trim() : '';
  const buyer_email = params.email;
  const buyer_name = (params.cardHolder || params.buyerName || '').trim();

  if (!buyer_email) throw new HttpError(400, 'Email manquant (PayMe).');
  if (!buyer_name) throw new HttpError(400, 'Nom porteur manquant (PayMe).');
  if (!credit_card_number) throw new HttpError(400, 'Numéro de carte manquant (PayMe).');
  if (!credit_card_exp) throw new HttpError(400, "Date d'expiration manquante (PayMe).");
  if (!credit_card_cvv) throw new HttpError(400, 'CVV manquant (PayMe).');

  const debug = process.env.PAYME_DEBUG === 'true';
  if (debug) console.log('[PayMe] Tentative capture-buyer-token:', { status: 'start' });

  const { ok, status, json } = await paymePostJson(
    'capture-buyer-token',
    {
      seller_payme_id,
      buyer_name,
      credit_card_number,
      credit_card_exp,
      credit_card_cvv,
      buyer_email,
      buyer_is_permanent: true,
      ...(buyer_zip_code ? { buyer_zip_code } : {})
    },
    (() => {
      const raw = Number(process.env.PAYME_CAPTURE_BUYER_TOKEN_TIMEOUT_MS || 20000);
      return Number.isFinite(raw) && raw > 0 ? raw : 20000;
    })()
  );

  if (debug) {
    console.log('[PayMe] Réponse capture-buyer-token:', {
      ok,
      status,
      errorCode: json?.status_error_code,
      keys: Object.keys(json || {})
    });
  }

  if (!ok || json?.status_error_code) {
    const err = new HttpError(
      400,
      "Impossible d'enregistrer la carte. Vérifiez le numéro, la date d'expiration et le CVV, puis réessayez.",
      'PAYME_CARD_INVALID_OR_DECLINED'
    );
    (err as any).statusCode = status;
    (err as any).errorCode = json?.status_error_code;
    attachPaymeDetails(err, {
      endpoint: 'capture-buyer-token',
      httpStatus: status,
      paymeStatusCode: paymeStatusCode(json),
      paymeErrorCode: json?.status_error_code,
      paymeErrorMessage: safePaymeErrorMessage(json)
    });
    throw err;
  }

  const buyerKey = pickFirstString(json, ['buyer_key', 'buyerKey']);
  // PayMe renvoie souvent buyer_card_mask (ex: ****1234) plutôt que buyer_card
  const buyerCard = pickFirstString(json, ['buyer_card', 'buyer_card_mask', 'buyerCard', 'buyerCardMask']);
  const buyerName = pickFirstString(json, ['buyer_name', 'buyerName']) || undefined;
  
  if (!buyerKey || !buyerCard) {
    // Log la réponse PayMe (sans données carte) pour debug
    console.error('PayMe capture-buyer-token: réponse invalide. Réponse:', {
      status,
      hasKey: Boolean(buyerKey),
      hasCard: Boolean(buyerCard),
      keys: Object.keys(json || {})
    });
    throw new HttpError(400, 'PayMe capture-buyer-token: réponse invalide.');
  }

  return { buyerKey, buyerCard, buyerName };
}

export async function paymeGenerateSale(params: {
  priceInCents: number; // ex: 24900
  description: string;
  buyerKey: string;
  installments?: number;
}): Promise<{ approved: true; salePaymeId: string }> {
  const seller_payme_id = requirePaymeSellerKey();
  const debug = process.env.PAYME_DEBUG === 'true';

  const { ok, status, json } = await paymePostJson(
    'generate-sale',
    {
      currency: 'ILS',
      sale_payment_method: 'credit-card',
      sale_type: 'sale',
      seller_payme_id,
      sale_price: String(params.priceInCents),
      product_name: params.description,
      buyer_key: params.buyerKey,
      ...(params.installments && params.installments > 1 ? { installments: String(params.installments) } : {})
    },
    20000
  );

  const saleStatusRaw = pickFirstString(json, ['sale_status', 'saleStatus']);
  const saleStatus = saleStatusRaw.toLowerCase().trim();

  if (debug) {
    console.log('[PayMe] Réponse generate-sale:', {
      ok,
      status,
      errorCode: json?.status_error_code,
      saleStatus: saleStatusRaw || null,
      keys: Object.keys(json || {})
    });
  }

  // Statuts possibles (PayMe peut varier selon environnements/versions)
  const SUCCESS_STATUSES = new Set(['approved', 'success', 'succeeded', 'paid', 'completed', 'ok']);
  const FAILURE_STATUSES = new Set(['failed', 'declined', 'error']);

  // Échec explicite
  if (!ok || json?.status_error_code || (saleStatus && FAILURE_STATUSES.has(saleStatus))) {
    const err = new HttpError(
      400,
      `Paiement refusé: ${safePaymeErrorMessage(json)}`,
      'PAYME_SALE_DECLINED'
    );
    (err as any).statusCode = status;
    (err as any).errorCode = json?.status_error_code;
    throw err;
  }

  // PayMe peut répondre 200 mais status_code != 0 => échec logique
  try {
    assertPaymeStatusCodeOk(json, 'Paiement refusé');
  } catch (e: any) {
    (e as any).statusCode = status;
    throw e;
  }

  const salePaymeId =
    pickFirstString(json, ['payme_sale_id', 'paymeSaleId', 'sale_payme_id', 'salePaymeId', 'sale_id', 'saleId']) ||
    pickFirstString(json?.data, ['payme_sale_id', 'paymeSaleId', 'sale_payme_id', 'salePaymeId', 'sale_id', 'saleId']);

  // Sécurité: si PayMe ne renvoie pas d'identifiant de vente, on ne peut pas confirmer
  // que le débit est réellement passé => on bloque le flow (pas de subscription / pas de user / pas de Firestore).
  if (!salePaymeId) {
    console.error('PayMe generate-sale: vente non confirmée (salePaymeId manquant).', {
      status,
      saleStatus: saleStatusRaw || null,
      keys: Object.keys(json || {})
    });
    const err = new HttpError(
      400,
      "Paiement non confirmé: la première vente n'est pas passée. Aucun abonnement n'a été créé.",
      'PAYME_SALE_NOT_CONFIRMED'
    );
    (err as any).statusCode = status;
    throw err;
  }

  // Si PayMe fournit un statut et qu'il n'est pas explicitement un succès, on bloque aussi (robustesse).
  if (saleStatus && !SUCCESS_STATUSES.has(saleStatus)) {
    console.error('PayMe generate-sale: statut non reconnu => vente non confirmée.', {
      status,
      saleStatus: saleStatusRaw || null,
      salePaymeId,
      keys: Object.keys(json || {})
    });
    const err = new HttpError(
      400,
      "Paiement non confirmé: la première vente n'est pas passée. Aucun abonnement n'a été créé.",
      'PAYME_SALE_NOT_CONFIRMED'
    );
    (err as any).statusCode = status;
    throw err;
  }

  return { approved: true, salePaymeId };
}

export async function paymeGenerateSubscription(params: {
  priceInCents: number;
  description: string;
  email: string;
  buyerKey: string;
  planIterationType: 3; // mensuel
  startDateDdMmYyyy: string;
}): Promise<PaymeSubscriptionResult> {
  const seller_payme_id = requirePaymeSellerKey();
  const debug = process.env.PAYME_DEBUG === 'true';

  const { ok, status, json } = await paymePostJson(
    'generate-subscription',
    {
      sale_payment_method: 'credit-card',
      sub_currency: 'ILS',
      sub_price: String(params.priceInCents),
      seller_payme_id,
      sub_description: params.description,
      sale_email: params.email,
      sub_iteration_type: params.planIterationType,
      buyer_key: params.buyerKey,
      sub_start_date: params.startDateDdMmYyyy
    },
    20000
  );

  if (debug) {
    console.log('[PayMe] Réponse generate-subscription:', {
      ok,
      status,
      errorCode: json?.status_error_code,
      keys: Object.keys(json || {})
    });
  }

  if (!ok || json?.status_error_code) {
    const err = new HttpError(
      400,
      "Impossible de créer l'abonnement pour le moment. Veuillez réessayer.",
      'PAYME_SUBSCRIPTION_FAILED'
    );
    (err as any).statusCode = status;
    (err as any).errorCode = json?.status_error_code;
    attachPaymeDetails(err, {
      endpoint: 'generate-subscription',
      httpStatus: status,
      paymeStatusCode: paymeStatusCode(json),
      paymeErrorCode: json?.status_error_code,
      paymeErrorMessage: safePaymeErrorMessage(json)
    });
    throw err;
  }

  const subCode = json?.sub_payme_code;
  const subID = typeof json?.sub_payme_id === 'string' ? json.sub_payme_id : '';
  if (!subID || (typeof subCode !== 'number' && typeof subCode !== 'string')) {
    throw new HttpError(400, 'PayMe generate-subscription: réponse invalide.');
  }

  return { subCode, subID };
}

export async function paymeSetSubscriptionPrice(params: { subId: string; priceInCents: number }): Promise<{ ok: true }> {
  const seller_payme_id = requirePaymeSellerKey();
  const debug = process.env.PAYME_DEBUG === 'true';

  const subId = (params.subId || '').trim();
  if (!subId) throw new HttpError(400, 'PayMe set-price: subId manquant.');
  const priceInCents = Number(params.priceInCents);
  if (!Number.isFinite(priceInCents) || priceInCents <= 0) throw new HttpError(400, 'PayMe set-price: prix invalide.');

  const { ok, status, json } = await paymePatchJson(
    `subscriptions/${encodeURIComponent(subId)}/set-price`,
    {
      seller_payme_id,
      // PayMe attend une valeur en agorot (ex: 50.75 => 5075)
      sub_price: String(priceInCents)
    },
    20000
  );

  if (debug) {
    console.log('[PayMe] Réponse subscriptions/{subId}/set-price:', {
      ok,
      status,
      errorCode: json?.status_error_code,
      statusCode: paymeStatusCode(json),
      keys: Object.keys(json || {})
    });
  }

  if (!ok || json?.status_error_code) {
    const err = new HttpError(400, `PayMe set-price: ${safePaymeErrorMessage(json)}`, 'PAYME_SET_PRICE_FAILED');
    (err as any).statusCode = status;
    (err as any).errorCode = json?.status_error_code;
    throw err;
  }

  // Réponse attendue typique: { status_code: 0 }
  assertPaymeStatusCodeOk(json, 'PayMe set-price');
  return { ok: true };
}

export async function paymeSetSubscriptionDescription(params: {
  subId: string;
  description: string;
  subCode?: number | string | null;
}): Promise<{ ok: true; used: { method: 'POST' | 'PATCH'; path: string } }> {
  const seller_payme_id = requirePaymeSellerKey();
  const debug = process.env.PAYME_DEBUG === 'true';

  const subId = (params.subId || '').trim();
  if (!subId) throw new HttpError(400, 'PayMe set-description: subId manquant.');
  const description = String(params.description || '').trim();
  if (!description) throw new HttpError(400, 'PayMe set-description: description manquante.');
  const subCode =
    typeof params.subCode === 'number' && Number.isFinite(params.subCode)
      ? params.subCode
      : typeof params.subCode === 'string' && params.subCode.trim()
        ? params.subCode.trim()
        : null;

  // PayMe n'est pas stable côté endpoints; on tente plusieurs variantes (best-effort).
  const attempts: Array<{ method: 'PATCH' | 'POST'; path: string; body: any }> = [
    // Hypothèse REST (cohérent avec set-price)
    {
      method: 'PATCH',
      path: `subscriptions/${encodeURIComponent(subId)}`,
      body: {
        seller_payme_id,
        // Selon les schémas, la colonne UI peut afficher description/product_name/plan_name
        sub_description: description,
        description,
        product_name: description,
        plan_name: description
      }
    },
    // Variante: endpoint dédié set-description
    {
      method: 'PATCH',
      path: `subscriptions/${encodeURIComponent(subId)}/set-description`,
      body: { seller_payme_id, sub_description: description, description, product_name: description, plan_name: description }
    },
    // Variante: set-details
    {
      method: 'PATCH',
      path: `subscriptions/${encodeURIComponent(subId)}/set-details`,
      body: { seller_payme_id, sub_description: description, description, product_name: description, plan_name: description }
    },
    // Variante "API style" (cohérent avec generate-subscription / get-subscriptions)
    {
      method: 'POST',
      path: 'set-subscription-description',
      body: {
        seller_payme_id,
        sub_payme_id: subId,
        ...(subCode != null ? { sub_payme_code: subCode } : {}),
        sub_description: description,
        description,
        product_name: description,
        plan_name: description
      }
    },
    {
      method: 'POST',
      path: 'update-subscription',
      body: {
        seller_payme_id,
        sub_payme_id: subId,
        ...(subCode != null ? { sub_payme_code: subCode } : {}),
        sub_description: description,
        description,
        product_name: description,
        plan_name: description
      }
    },
    {
      method: 'POST',
      path: 'edit-subscription',
      body: {
        seller_payme_id,
        sub_payme_id: subId,
        ...(subCode != null ? { sub_payme_code: subCode } : {}),
        sub_description: description,
        description,
        product_name: description,
        plan_name: description
      }
    }
  ];

  let last: { ok: boolean; status: number; json: any } | null = null;

  for (const a of attempts) {
    try {
      const reqFn = a.method === 'PATCH' ? paymePatchJson : paymePostJson;
      const { ok, status, json } = await reqFn(a.path, a.body, 20000);
      last = { ok, status, json };

      if (debug) {
        console.log(`[PayMe] Réponse ${a.method} ${a.path} (set-description):`, {
          ok,
          status,
          errorCode: json?.status_error_code,
          statusCode: paymeStatusCode(json),
          keys: Object.keys(json || {})
        });
      }

      if (!ok || json?.status_error_code) continue;
      assertPaymeStatusCodeOk(json, 'PayMe set-description');
      return { ok: true, used: { method: a.method, path: a.path } };
    } catch (e: any) {
      // Continue: si une variante échoue, on tente les suivantes.
      last = {
        ok: false,
        status: Number((e as any)?.statusCode || (e as any)?.status || 0) || 0,
        json: (e as any)?.payme || null
      };
      continue;
    }
  }

  const err = new HttpError(400, `PayMe set-description: ${safePaymeErrorMessage(last?.json)}`, 'PAYME_SET_DESCRIPTION_FAILED');
  (err as any).statusCode = last?.status || 0;
  (err as any).errorCode = last?.json?.status_error_code ?? null;
  attachPaymeDetails(err, {
    endpoint: 'set-description',
    attempted: attempts.map((a) => ({ method: a.method, path: a.path })),
    httpStatus: last?.status || null,
    paymeStatusCode: last?.json ? paymeStatusCode(last.json) : null,
    paymeErrorCode: last?.json?.status_error_code ?? null,
    paymeErrorMessage: last?.json ? safePaymeErrorMessage(last.json) : null
  });
  throw err;
}

async function paymeSubscriptionAction(params: {
  subId: string;
  action: 'pause' | 'resume' | 'cancel';
}): Promise<{ ok: true; raw?: any; used: { method: 'POST' | 'PATCH'; path: string } }> {
  const seller_payme_id = requirePaymeSellerKey();
  const debug = process.env.PAYME_DEBUG === 'true';

  const subId = (params.subId || '').trim();
  if (!subId) throw new HttpError(400, `PayMe ${params.action}: subId manquant.`);

  // PayMe n'est pas cohérent entre endpoints:
  // - set-price est REST (PATCH /subscriptions/{id}/set-price)
  // - pause/resume/cancel peuvent être REST ou via endpoints /api/{action}-subscription
  const attempts: Array<{ method: 'PATCH' | 'POST'; path: string; body: any }> = [
    // Tentative REST (PATCH) - comme set-price
    { method: 'PATCH', path: `subscriptions/${encodeURIComponent(subId)}/${params.action}`, body: { seller_payme_id } },
    // Certaines implémentations utilisent POST pour les actions
    { method: 'POST', path: `subscriptions/${encodeURIComponent(subId)}/${params.action}`, body: { seller_payme_id } },
    // Fallback "API style" (cohérent avec generate-subscription / get-subscriptions)
    // NB: on passe sub_payme_id car c'est l'identifiant retourné par PayMe (subID)
    { method: 'POST', path: `${params.action}-subscription`, body: { seller_payme_id, sub_payme_id: subId } },
    { method: 'POST', path: `${params.action}-subscription`, body: { seller_payme_id, sub_payme_id: subId, subId } }
  ];

  let lastErr: any = null;

  for (const a of attempts) {
    try {
      const reqFn = a.method === 'PATCH' ? paymePatchJson : paymePostJson;
      const { ok, status, json } = await reqFn(a.path, a.body, 20000);

      if (debug) {
        console.log(`[PayMe] Réponse ${a.method} ${a.path}:`, {
          ok,
          status,
          errorCode: json?.status_error_code,
          statusCode: paymeStatusCode(json),
          keys: Object.keys(json || {})
        });
      }

      if (!ok || json?.status_error_code) {
        const err = new HttpError(400, `PayMe ${params.action}: ${safePaymeErrorMessage(json)}`);
        (err as any).statusCode = status;
        (err as any).errorCode = json?.status_error_code;
        throw err;
      }

      // Réponse attendue typique: { status_code: 0 }
      assertPaymeStatusCodeOk(json, `PayMe ${params.action}`);
      return { ok: true, raw: json, used: { method: a.method, path: a.path } };
    } catch (e: any) {
      lastErr = e;

      // Si 404 => endpoint non trouvé => on tente l'alternative suivante
      const statusCode = Number((e as any)?.statusCode || 0);
      if (statusCode === 404) continue;

      // Si c'est une erreur PayMe "logique" (400/401/403 etc), inutile de tenter d'autres endpoints
      throw e;
    }
  }

  // Aucun endpoint n'a matché (404 partout)
  if (lastErr) throw lastErr;
  throw new HttpError(400, `PayMe ${params.action}: endpoint introuvable.`);
}

export async function paymePauseSubscription(params: { subId: string }): Promise<{ ok: true }> {
  await paymeSubscriptionAction({ subId: params.subId, action: 'pause' });
  return { ok: true };
}

export async function paymeResumeSubscription(params: { subId: string }): Promise<{ ok: true }> {
  await paymeSubscriptionAction({ subId: params.subId, action: 'resume' });
  return { ok: true };
}

export async function paymeCancelSubscription(params: { subId: string }): Promise<{ ok: true }> {
  await paymeSubscriptionAction({ subId: params.subId, action: 'cancel' });
  return { ok: true };
}

export function formatDdMmYyyy(date: Date): string {
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = String(date.getFullYear());
  return `${dd}/${mm}/${yyyy}`;
}

function formatDdMmYyyyParts(day: number, month: number, year: number): string {
  return `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`;
}

/**
 * Calcule la date de début d'abonnement PayMe (format dd/MM/yyyy) selon les règles métier.
 * - plan=3 (mensuel): +1 mois ; si jour >= 29 => 1er du mois suivant (donc +2 mois) ; sinon day=min(day,28)
 * - plan=4 (annuel): +1 an ; si 29/02 => 01/03 ; sinon day=min(day,28)
 */
export function calculateSubscriptionStartDate(plan: number, now: Date = new Date()): string {
  if (plan === 3) {
    // Month in 1..12
    const currentMonth = now.getMonth() + 1;
    const currentYear = now.getFullYear();
    const dayNow = now.getDate();

    // +1 mois
    let month1 = currentMonth + 1;
    let year1 = currentYear;
    if (month1 > 12) {
      month1 = 1;
      year1 += 1;
    }

    // si jour >= 29 => 1er du mois suivant (donc +2 mois au total)
    if (dayNow >= 29) {
      let month2 = month1 + 1;
      let year2 = year1;
      if (month2 > 12) {
        month2 = 1;
        year2 += 1;
      }
      return formatDdMmYyyyParts(1, month2, year2);
    }

    // sinon, garder le même jour mais <= 28
    const day = Math.min(dayNow, 28);
    return formatDdMmYyyyParts(day, month1, year1);
  }

  if (plan === 4) {
    const targetYear = now.getFullYear() + 1;
    const month = now.getMonth() + 1;
    const dayNow = now.getDate();

    // 29 février => 1er mars
    if (dayNow === 29 && month === 2) {
      return formatDdMmYyyyParts(1, 3, targetYear);
    }

    const day = Math.min(dayNow, 28);
    return formatDdMmYyyyParts(day, month, targetYear);
  }

  throw new Error(`Plan invalide: ${plan}`);
}

export type PaymeHostedSaleResult = {
  sale_url: string;
  payme_sale_id: string;
};

/**
 * Generate a hosted sale URL on PayMe. The buyer is redirected to this page
 * to enter card details. PayMe calls `callbackUrl` (webhook) after payment
 * and redirects the buyer to `returnUrl`.
 */
export async function paymeGenerateHostedSale(params: {
  priceInCents: number;
  description: string;
  buyerEmail?: string;
  buyerName?: string;
  callbackUrl: string;
  returnUrl: string;
}): Promise<PaymeHostedSaleResult> {
  const seller_payme_id = requirePaymeSellerKey();
  assertHttps(params.callbackUrl, 'sale_callback_url');

  const body: Record<string, any> = {
    seller_payme_id,
    sale_price: String(params.priceInCents),
    currency: 'ILS',
    product_name: params.description,
    sale_type: 'sale',
    sale_payment_method: 'credit-card',
    capture_buyer: true,
    sale_send_notification: true,
    sale_callback_url: params.callbackUrl,
    sale_return_url: params.returnUrl,
  };
  if (params.buyerEmail) body.sale_email = params.buyerEmail;
  if (params.buyerName) body.sale_name = params.buyerName;

  const { ok, status, json } = await paymePostJson('generate-sale', body, 20000);

  if (!ok || json?.status_error_code) {
    const err = new HttpError(
      400,
      `Impossible de créer la session de paiement: ${safePaymeErrorMessage(json)}`,
      'PAYME_HOSTED_SALE_FAILED'
    );
    (err as any).statusCode = status;
    (err as any).errorCode = json?.status_error_code;
    throw err;
  }

  try {
    assertPaymeStatusCodeOk(json, 'Session de paiement échouée');
  } catch (e: any) {
    (e as any).statusCode = status;
    throw e;
  }

  const sale_url = pickFirstString(json, ['sale_url', 'saleUrl']);
  const payme_sale_id = pickFirstString(json, [
    'payme_sale_id', 'paymeSaleId', 'sale_payme_id', 'salePaymeId', 'sale_id', 'saleId'
  ]) || pickFirstString(json?.data, [
    'payme_sale_id', 'paymeSaleId', 'sale_payme_id', 'salePaymeId', 'sale_id', 'saleId'
  ]);

  if (!sale_url) {
    throw new HttpError(400, 'PayMe n\'a pas retourné de sale_url.', 'PAYME_NO_SALE_URL');
  }

  return { sale_url, payme_sale_id };
}
