import dotenv from 'dotenv';
import path from 'path';
import { paymeListSubscriptions, type PaymeSubscriptionListItem } from '../src/services/payme.service.js';

type Args = {
  amountIls: number;
  activeOnly: boolean;
};

function loadEnv(): void {
  dotenv.config();
  dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
}

function parseArgs(argv: string[]): Args {
  let amountIls = 69;
  let activeOnly = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--amount-ils') {
      const n = Number(String(argv[i + 1] || '').trim());
      if (Number.isFinite(n) && n > 0) amountIls = n;
    }
    if (a === '--active-only') activeOnly = true;
  }

  return { amountIls, activeOnly };
}

function parsePaymeMoneyToAgorot(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
  if (typeof value === 'string' && value.trim()) {
    const s0 = value.trim().replace(',', '.');
    if (!s0) return null;
    if (s0.includes('.')) {
      const f = Number(s0);
      return Number.isFinite(f) ? Math.round(f * 100) : null;
    }
    const n = Number(s0);
    return Number.isFinite(n) ? Math.round(n) : null;
  }
  return null;
}

function pickPaymeSubscriptionAmountRaw(item: any): unknown {
  return (
    item?.sub_price ??
    item?.subPrice ??
    item?.transaction_periodical_payment ??
    item?.transactionPeriodicalPayment ??
    item?.transaction_first_payment ??
    item?.transactionFirstPayment ??
    item?.sale_price ??
    item?.salePrice ??
    item?.sale_price_after_fees ??
    item?.salePriceAfterFees ??
    item?.price ??
    item?.amount ??
    item?.sale?.sale_price ??
    item?.sale?.price ??
    null
  );
}

function pickCurrentSubscriptionPriceInCents(sub: PaymeSubscriptionListItem): number | null {
  const rawPrice = pickPaymeSubscriptionAmountRaw(sub.raw);
  const agorot = parsePaymeMoneyToAgorot(rawPrice);
  return typeof agorot === 'number' && Number.isFinite(agorot) && agorot > 0 ? agorot : null;
}

function formatStatus(status: number | null): string {
  if (status == null) return 'unknown';
  if (status === 2) return 'active(2)';
  if (status === 5) return 'cancelled(5)';
  return String(status);
}

async function main(): Promise<void> {
  loadEnv();
  const { amountIls, activeOnly } = parseArgs(process.argv.slice(2));
  const targetCents = Math.round(amountIls * 100);

  console.log('[check-payme-subscriptions-69] LECTURE SEULE');
  console.log('[check-payme-subscriptions-69] Chargement des abonnements PayMe...');

  const subscriptions = await paymeListSubscriptions();
  const rows = subscriptions
    .map((s) => {
      const priceInCents = pickCurrentSubscriptionPriceInCents(s);
      return {
        subCode: s.subCode != null ? String(s.subCode) : '',
        subId: s.subId || '',
        email: s.email || '',
        description: s.description || '',
        status: s.subStatus,
        nextPaymentDate: s.nextPaymentDateYmd || '',
        priceInCents
      };
    })
    .filter((r) => r.priceInCents === targetCents)
    .filter((r) => (activeOnly ? r.status === 2 : true))
    .sort((a, b) => a.email.localeCompare(b.email));

  const activeCount = rows.filter((r) => r.status === 2).length;
  const cancelledCount = rows.filter((r) => r.status === 5).length;
  const otherStatusCount = rows.length - activeCount - cancelledCount;

  console.log('[check-payme-subscriptions-69] Résumé', {
    targetIls: amountIls,
    targetCents,
    activeOnly,
    paymeSubscriptionsTotal: subscriptions.length,
    matches: rows.length,
    activeCount,
    cancelledCount,
    otherStatusCount
  });

  if (rows.length === 0) {
    console.log('[check-payme-subscriptions-69] Aucun abonnement trouvé pour ce montant.');
    return;
  }

  console.log('');
  console.log('subCode | subId | status | email | amount | nextPaymentDate | description');
  console.log('------- | ----- | ------ | ----- | ------ | --------------- | -----------');
  for (const r of rows) {
    const amount = r.priceInCents != null ? (r.priceInCents / 100).toFixed(2) : '';
    console.log(
      `${r.subCode || '-'} | ${r.subId || '-'} | ${formatStatus(r.status)} | ${r.email || '-'} | ${amount} ILS | ${
        r.nextPaymentDate || '-'
      } | ${(r.description || '-').replaceAll('\n', ' ')}`
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[check-payme-subscriptions-69] Erreur:', e?.message || String(e));
    process.exit(1);
  });
