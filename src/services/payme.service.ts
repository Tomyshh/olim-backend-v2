import { HttpError } from '../utils/errors.js';

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
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    const status = res.status;
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, status, json };
  } catch (e: any) {
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

  if (!ok || json?.status_error_code) {
    const err = new HttpError(400, `PayMe capture-buyer-token: ${safePaymeErrorMessage(json)}`);
    (err as any).statusCode = status;
    (err as any).errorCode = json?.status_error_code;
    throw err;
  }

  const buyerKey = typeof json?.buyer_key === 'string' ? json.buyer_key : '';
  const buyerCard = typeof json?.buyer_card === 'string' ? json.buyer_card : '';
  const buyerName = typeof json?.buyer_name === 'string' ? json.buyer_name : undefined;
  if (!buyerKey || !buyerCard) throw new HttpError(400, 'PayMe capture-buyer-token: réponse invalide.');

  return { buyerKey, buyerCard, buyerName };
}

export async function paymeGenerateSale(params: {
  priceInCents: number; // ex: 24900
  description: string;
  buyerKey: string;
  installments?: number;
}): Promise<{ approved: boolean }> {
  const seller_payme_id = requirePaymeSellerKey();

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

  if (!ok || json?.status_error_code || json?.sale_status === 'failed') {
    const err = new HttpError(400, `PayMe generate-sale: ${safePaymeErrorMessage(json)}`);
    (err as any).statusCode = status;
    (err as any).errorCode = json?.status_error_code;
    throw err;
  }

  return { approved: json?.sale_status === 'approved' };
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

export function formatDdMmYyyy(date: Date): string {
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = String(date.getFullYear());
  return `${dd}/${mm}/${yyyy}`;
}


