import type { Response } from 'express';
import type { AuthenticatedRequest } from '../../middleware/auth.middleware.js';
import { supabase } from '../../services/supabase.service.js';
import { resolveSupabaseClientId } from '../../services/dualWrite.service.js';

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

  let subscription: any = null;

  if (clientData.free_access && (clientData.free_access as any)?.isEnabled) {
    subscription = {
      type: 'freeAccess',
      status: 'active',
      expiresAt: (clientData.free_access as any).expiresAt,
      membership: (clientData.free_access as any).membership
    };
  } else if (clientData.membership_type) {
    subscription = {
      type: 'membership',
      status: clientData.is_unpaid ? 'unpaid' : 'active',
      plan: clientData.metadata?.subscriptionPlan ?? null,
      legacy: true
    };
  }

  const clientId = clientData.id;

  const { data: subData } = await supabase
    .from('subscriptions')
    .select('*')
    .eq('client_id', clientId)
    .single();

  if (subData) {
    subscription = { ...subscription, ...subData };
  }

  const { data: membersData } = await supabase
    .from('family_members')
    .select('*')
    .eq('client_id', clientId);

  const familyMembers = (membersData ?? []).map((d) => ({ memberId: d.firestore_id ?? d.id, ...d }));

  res.json({ subscription, familyMembers });
}


