import { HttpError } from '../utils/errors.js';
import { runWithConcurrencyLimit } from './concurrencyLimit.service.js';

type PaymeCaptureBuyerTokenResult = {
  buyerKey: string;
  buyerCard: string;
  buyerName?: string;
};

type PaymeSubscriptionResult = {
  subCode: number | string;
  subID: string;
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

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const limit = Number(process.env.PAYME_CONCURRENCY || 5);
    const waitTimeoutMs = Number(process.env.PAYME_WAIT_TIMEOUT_MS || 5000);

    const res = await runWithConcurrencyLimit({
      key: 'payme',
      limit: Number.isFinite(limit) && limit > 0 ? limit : 5,
      waitTimeoutMs: Number.isFinite(waitTimeoutMs) && waitTimeoutMs > 0 ? waitTimeoutMs : 5000,
      fn: async () =>
        await fetch(url, {
          method,
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(body),
          signal: ctrl.signal
        })
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
    if (e?.name === 'AbortError') throw new HttpError(400, 'Timeout PayMe.');
    throw new HttpError(400, 'Erreur PayMe.');
  } finally {
    clearTimeout(t);
  }
}

export async function paymeCaptureBuyerToken(params: {
  email: string;
  buyerName: string;
  cardHolder?: string;
  cardNumber: unknown;
  expirationDate: unknown; // MM/YY
  cvv: unknown;
}): Promise<PaymeCaptureBuyerTokenResult> {
  const seller_payme_id = requirePaymeSellerKey();

  const credit_card_number = normalizeCardNumberDigitsOnly(params.cardNumber);
  const credit_card_exp = typeof params.expirationDate === 'string' ? params.expirationDate.trim() : '';
  const credit_card_cvv = typeof params.cvv === 'string' ? params.cvv.trim() : '';
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
      buyer_is_permanent: true
    },
    12000
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
    const err = new HttpError(400, `PayMe capture-buyer-token: ${safePaymeErrorMessage(json)}`);
    (err as any).statusCode = status;
    (err as any).errorCode = json?.status_error_code;
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
    const err = new HttpError(400, `PayMe generate-subscription: ${safePaymeErrorMessage(json)}`);
    (err as any).statusCode = status;
    (err as any).errorCode = json?.status_error_code;
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
    const err = new HttpError(400, `PayMe set-price: ${safePaymeErrorMessage(json)}`);
    (err as any).statusCode = status;
    (err as any).errorCode = json?.status_error_code;
    throw err;
  }

  // Réponse attendue typique: { status_code: 0 }
  assertPaymeStatusCodeOk(json, 'PayMe set-price');
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


