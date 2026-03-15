import type { Request, Response } from 'express';
import { admin, getFirestore } from '../config/firebase.js';
import { supabase } from '../services/supabase.service.js';
import {
  calculateSubscriptionStartDate,
  paymeGenerateSubscription,
} from '../services/payme.service.js';
import {
  dualWriteSubscription,
  dualWriteClient,
  dualWritePaymentCredential,
  dualWriteToSupabase,
} from '../services/dualWrite.service.js';

function pickStr(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function stripUndefined<T>(value: T): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const out: any = {};
  for (const [k, v] of Object.entries(value as any)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

const SUCCESS_STATUSES = new Set(['approved', 'completed', 'sale-complete', 'success', 'paid']);

/**
 * POST /api/payme/subscription-webhook
 * Called by PayMe after a hosted sale completes. No auth — PayMe cannot authenticate.
 */
export async function handleSubscriptionWebhook(req: Request, res: Response): Promise<void> {
  const payload = req.body || {};

  const paymeSaleId = pickStr(payload.payme_sale_id) || pickStr(payload.sale_payme_id) || pickStr(payload.sale_id);
  const saleStatus = (pickStr(payload.sale_status) || pickStr(payload.status) || pickStr(payload.notify_type)).toLowerCase();
  const buyerKey = pickStr(payload.buyer_key) || pickStr(payload.token) || pickStr(payload.buyer_token);
  const buyerCardMask = pickStr(payload.buyer_card_mask) || pickStr(payload.card_mask) || pickStr(payload.buyer_card);
  const buyerCardExp = pickStr(payload.buyer_card_exp) || pickStr(payload.card_exp);

  console.log('[paymeWebhook] Received', {
    paymeSaleId: paymeSaleId || null,
    saleStatus: saleStatus || null,
    hasBuyerKey: Boolean(buyerKey),
  });

  if (!paymeSaleId) {
    console.warn('[paymeWebhook] No payme_sale_id in payload');
    res.status(200).json({ received: true });
    return;
  }

  const { data: session, error: fetchError } = await supabase
    .from('pending_payment_sessions')
    .select('*')
    .eq('payme_sale_id', paymeSaleId)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (fetchError || !session) {
    console.warn('[paymeWebhook] No pending session found for payme_sale_id', paymeSaleId, fetchError);
    res.status(200).json({ received: true });
    return;
  }

  const isSuccess = SUCCESS_STATUSES.has(saleStatus);

  if (!isSuccess) {
    await supabase
      .from('pending_payment_sessions')
      .update({ status: 'failed', updated_at: new Date().toISOString() })
      .eq('id', session.id);
    console.warn('[paymeWebhook] Sale failed', { paymeSaleId, saleStatus });
    res.status(200).json({ received: true });
    return;
  }

  if (!buyerKey) {
    console.error('[paymeWebhook] Sale approved but no buyer_key', { paymeSaleId });
    await supabase
      .from('pending_payment_sessions')
      .update({ status: 'failed', updated_at: new Date().toISOString() })
      .eq('id', session.id);
    res.status(200).json({ received: true });
    return;
  }

  try {
    const clientId = session.client_firebase_uid;
    const membership: string = session.membership;
    const planType: string = session.plan_type;
    const priceInCents: number = session.price_cents;
    const installments: number = session.installments || 1;
    const promoCode: string | null = session.promo_code;
    const createdByUid: string | null = session.created_by_uid;
    const email = session.metadata?.buyer_email || '';
    const planNumber: 3 | 4 = planType === 'annual' ? 4 : 3;

    const db = getFirestore();
    const clientRef = db.collection('Clients').doc(clientId);

    // Save payment credential in Firestore
    const credId = `hosted_${paymeSaleId}`;
    const credData: Record<string, any> = {
      'Isracard Key': buyerKey,
      'Card Number': buyerCardMask || null,
      'Card Holder': null,
      'Card Name': null,
      isSubscriptionCard: true,
      isDefault: true,
      'Created From': 'payme_hosted_sale',
      'Created At': new Date().toISOString(),
    };
    if (buyerCardExp) {
      const parts = buyerCardExp.split('/');
      if (parts.length === 2) {
        credData.expiryMonth = parts[0];
        credData.expiryYear = parts[1];
      }
    }

    await clientRef.collection('Payment credentials').doc(credId).set(credData, { merge: true });
    dualWritePaymentCredential(clientId, credId, credData).catch(() => {});

    // Create PayMe subscription for monthly plans
    let subCode: number | string | null = null;
    let subID: string | null = null;
    let startDateDdMmYyyy: string | null = null;

    if (planNumber === 3 && email) {
      startDateDdMmYyyy = calculateSubscriptionStartDate(3);
      const sub = await paymeGenerateSubscription({
        priceInCents,
        description: membership,
        email,
        buyerKey,
        planIterationType: 3,
        startDateDdMmYyyy,
      });
      subCode = sub.subCode;
      subID = sub.subID;
    }

    const parseDdMmYyyy = (v: string): Date | null => {
      const m = v.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
      if (!m) return null;
      return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]), 12, 0, 0);
    };

    const nextPaymentDate = planNumber === 3 && startDateDdMmYyyy ? parseDdMmYyyy(startDateDdMmYyyy) : null;

    const now = new Date();
    const isAnnual = planNumber === 4;
    const endDate = new Date(now);
    if (isAnnual) endDate.setFullYear(endDate.getFullYear() + 1);
    else endDate.setMonth(endDate.getMonth() + 1);

    const subscriptionDoc = stripUndefined({
      plan: {
        type: isAnnual ? 'annual' : 'monthly',
        membership,
        price: priceInCents,
        currency: 'ILS',
        basePriceInCents: priceInCents,
      },
      payment: {
        method: 'credit-card',
        installments: installments > 1 ? installments : 1,
        nextPaymentDate: nextPaymentDate || endDate,
        lastPaymentDate: now,
      },
      payme: {
        subCode: subCode ?? null,
        subID: subID ?? null,
        buyerKey,
        status: 1,
      },
      dates: {
        startDate: now,
        endDate,
        pausedDate: null,
        cancelledDate: null,
        resumedDate: null,
      },
      states: {
        isActive: true,
        isPaused: false,
        willExpire: false,
        isAnnual,
      },
      history: {
        previousMembership: null,
        previousPlan: null,
        lastModified: now,
        modifiedBy: createdByUid || 'webhook',
      },
      ...(promoCode ? { promoCode } : {}),
      createdAt: now,
      updatedAt: now,
    });

    const batch = db.batch();
    batch.set(
      clientRef.collection('subscription').doc('current'),
      subscriptionDoc,
      { merge: true }
    );
    batch.set(
      clientRef,
      stripUndefined({
        Membership: membership,
        subPlan: planNumber,
        isUnpaid: false,
        sale_payme_id: paymeSaleId,
        ...(subID ? { paymeSubID: subID, 'IsraCard Sub ID': subID } : {}),
        ...(subCode != null ? { israCard_subCode: subCode } : {}),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }),
      { merge: true }
    );
    await batch.commit();

    dualWriteSubscription(clientId, subscriptionDoc).catch(() => {});
    dualWriteClient(clientId, {
      membership_type: membership,
      subscription_status: 'active',
      is_unpaid: false,
    }).catch(() => {});

    await supabase
      .from('pending_payment_sessions')
      .update({ status: 'completed', updated_at: new Date().toISOString() })
      .eq('id', session.id);

    console.log('[paymeWebhook] Subscription created successfully', { clientId, membership, planType, subID });
  } catch (err: any) {
    console.error('[paymeWebhook] Error processing webhook', err);
    await supabase
      .from('pending_payment_sessions')
      .update({ status: 'failed', updated_at: new Date().toISOString(), metadata: { ...session.metadata, error: String(err?.message || err) } })
      .eq('id', session.id);
  }

  res.status(200).json({ received: true });
}
