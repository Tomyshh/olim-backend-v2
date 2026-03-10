import type { Response } from 'express';
import type { AuthenticatedRequest } from '../../middleware/auth.middleware.js';
import { supabase } from '../../services/supabase.service.js';

export async function v1GetMeMembership(req: AuthenticatedRequest, res: Response): Promise<void> {
  const uid = req.uid!;

  const { data: clientData, error: clientError } = await supabase
    .from('clients')
    .select('*')
    .eq('firebase_uid', uid)
    .single();

  if (clientError || !clientData) {
    res.status(404).json({ message: 'Client not found', error: 'Client not found' });
    return;
  }

  const clientId = clientData.id;

  const { data: subData } = await supabase
    .from('subscriptions')
    .select('*')
    .eq('client_id', clientId)
    .single();

  let subscription: any = null;

  if (subData) {
    subscription = {
      plan: {
        membership: subData.membership_type,
        type: subData.plan_type,
        price: subData.price_cents,
        basePriceInCents: subData.price_cents,
        currency: subData.currency ?? 'ILS',
      },
      states: {
        isActive: subData.is_active ?? false,
        willExpire: subData.will_expire ?? false,
        isAnnual: subData.is_annual ?? false,
        isPaused: subData.is_paused ?? false,
        isUnpaid: subData.is_unpaid ?? false,
      },
      isUnpaid: subData.is_unpaid ?? false,
      payme: {
        subCode: subData.payme_sub_code,
        subId: subData.payme_sub_id,
        status: subData.payme_sub_status,
      },
      raw: subData,
    };
  } else if (clientData.free_access && (clientData.free_access as any)?.isEnabled) {
    subscription = {
      plan: {
        membership: (clientData.free_access as any).membership ?? clientData.membership_type,
        type: 'freeAccess',
      },
      states: { isActive: true },
      freeAccess: clientData.free_access,
    };
  } else if (clientData.membership_type) {
    subscription = {
      plan: {
        membership: clientData.membership_type,
      },
      states: {
        isActive: !clientData.is_unpaid,
        isUnpaid: clientData.is_unpaid ?? false,
      },
      isUnpaid: clientData.is_unpaid ?? false,
    };
  }

  const { data: membersData } = await supabase
    .from('family_members')
    .select('*')
    .eq('client_id', clientId);

  const familyMembers = (membersData ?? []).map((d) => ({ memberId: d.firestore_id ?? d.id, ...d }));

  res.json({ subscription, familyMembers });
}


