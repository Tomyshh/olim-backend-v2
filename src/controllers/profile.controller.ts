import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { getFirestore } from '../config/firebase.js';
import { supabase } from '../services/supabase.service.js';
import { dualWriteClient, dualWriteFamilyMember, dualWriteAddress, dualWriteDelete, resolveSupabaseClientId } from '../services/dualWrite.service.js';

export async function getProfile(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const { data, error } = await supabase
      .from('clients')
      .select('*')
      .eq('firebase_uid', uid)
      .single();

    if (error || !data) {
      res.status(404).json({ error: 'Profile not found' });
      return;
    }

    // Fetch subscription data from Supabase subscriptions table
    let subscription: Record<string, any> | null = null;
    try {
      const { data: subData } = await supabase
        .from('subscriptions')
        .select('*')
        .eq('client_id', data.id)
        .single();

      if (subData) {
        subscription = {
          plan: {
            membership: subData.membership_type,
            type: subData.plan_type,
            price: subData.price_cents,
            basePriceInCents: subData.price_cents,
            currency: subData.currency ?? 'ILS',
            familySupplementCount: 0,
            familySupplementTotalInCents: subData.family_supplement_cents ?? 0,
          },
          states: {
            isActive: subData.is_active ?? false,
            willExpire: subData.will_expire ?? false,
            isAnnual: subData.is_annual ?? false,
            isPaused: subData.is_paused ?? false,
            isUnpaid: subData.is_unpaid ?? false,
          },
          pricing: {
            basePriceInCents: subData.price_cents,
            chargedPriceInCents: subData.price_cents,
            discountInCents: 0,
          },
          isUnpaid: subData.is_unpaid ?? false,
          payme: {
            subCode: subData.payme_sub_code,
            subId: subData.payme_sub_id,
            subID: subData.payme_sub_id,
            buyerKey: subData.payme_buyer_key,
            status: subData.payme_sub_status,
            sub_status: subData.payme_sub_status,
            nextPaymentDate: subData.payme_next_payment_date ?? subData.next_payment_at,
            next_payment_date: subData.payme_next_payment_date ?? subData.next_payment_at,
          },
          promoCode: subData.promo_code ? {
            code: subData.promo_code,
            source: subData.promo_source,
            appliedDate: subData.promo_applied_at,
            expiresAt: subData.promo_expires_at,
          } : null,
          dates: {
            startDate: subData.start_at,
            endDate: subData.end_at,
            cancelledDate: subData.cancelled_at,
            resumedDate: subData.resumed_at,
          },
          familySupplement: {
            monthlyCents: subData.family_supplement_cents,
          },
          payment: {
            method: subData.payment_method,
            installments: subData.installments,
            nextPaymentDate: subData.next_payment_at,
            lastPaymentDate: subData.last_payment_at,
          },
          metadata: subData.metadata,
        };

        // Count family members with monthly_supplement_cents > 0 for familySupplementCount
        try {
          const { count } = await supabase
            .from('family_members')
            .select('*', { count: 'exact', head: true })
            .eq('client_id', data.id)
            .gt('monthly_supplement_cents', 0);
          if (count != null && subscription.plan) {
            subscription.plan.familySupplementCount = count;
          }
        } catch (_) { /* best-effort */ }
      }
    } catch (_) { /* best-effort: don't fail profile if subscription lookup fails */ }

    res.json({
      uid,
      ...data,
      // Legacy aliases for Flutter app backward compatibility
      'First Name': data.first_name,
      'Last Name': data.last_name,
      'Father Name': data.father_name,
      'Email': data.email,
      'Birthday': data.birthday,
      'Teoudat Zeout': data.teoudat_zeout,
      'Koupat Holim': data.koupat_holim,
      koupatHolim: data.koupat_holim,
      'Civility': data.civility,
      'Created At': data.created_at,
      'Created From': data.created_from,
      'Membership': data.membership_type,
      registrationComplete: data.registration_complete,
      hasGOVAccess: data.has_gov_access,
      freeAccess: data.free_access,
      isUnpaid: data.is_unpaid,
      subscription,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function updateProfile(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const updates = req.body;
    const db = getFirestore();

    await db.collection('Clients').doc(uid).update({
      ...updates,
      'Updated At': new Date()
    });

    const updatedDoc = await db.collection('Clients').doc(uid).get();
    const updatedData = updatedDoc.data();
    if (updatedData) dualWriteClient(uid, updatedData).catch(() => {});
    res.json({ uid, ...updatedData });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function checkProfileComplete(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const { data, error } = await supabase
      .from('clients')
      .select('*')
      .eq('firebase_uid', uid)
      .single();

    if (error || !data) {
      res.status(404).json({ error: 'Profile not found' });
      return;
    }

    const isComplete = data.registration_complete === true ||
      (!!data.first_name?.trim() && !!data.last_name?.trim());
    res.json({ isComplete, profile: data });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function updateLanguage(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const { language } = req.body;
    const db = getFirestore();

    await db.collection('Clients').doc(uid).update({ language });
    dualWriteClient(uid, { language }).catch(() => {});

    res.json({ message: 'Language updated', language });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function getFamilyMembers(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const clientId = await resolveSupabaseClientId(uid);
    if (!clientId) {
      res.status(404).json({ error: 'Client not found' });
      return;
    }

    const { data, error } = await supabase
      .from('family_members')
      .select('*')
      .eq('client_id', clientId);

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    const members = (data ?? []).map((m: any) => ({
      memberId: m.firestore_id ?? m.id,
      ...m,
      'First Name': m.first_name,
      'Last Name': m.last_name,
      'Father Name': m.father_name,
      'Birthday': m.birthday,
      'Teoudat Zeout': m.teoudat_zeout,
      'Koupat Holim': m.koupat_holim,
      'Family Member Status': m.status ?? m.relationship_type,
      'Prénom': m.first_name,
      'Nom': m.last_name,
      'Père': m.father_name,
      'Civilité': m.civility,
      'Teudat zeout': m.teoudat_zeout,
      'Date de naissance': m.birthday,
      firstName: m.first_name,
      lastName: m.last_name,
      isAccountOwner: m.is_account_owner,
      hasGOVacces: m.has_gov_access,
      hasGovAccess: m.has_gov_access,
      isActive: m.is_active,
    }));
    res.json({ members, familyMembers: members });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function addFamilyMember(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const memberData = req.body;
    const db = getFirestore();

    const memberRef = await db
      .collection('Clients')
      .doc(uid)
      .collection('Family Members')
      .add({
        ...memberData,
        createdAt: new Date()
      });

    dualWriteFamilyMember(uid, memberRef.id, { ...memberData, createdAt: new Date() }).catch(() => {});
    res.status(201).json({ memberId: memberRef.id, ...memberData });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function updateFamilyMember(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const { memberId } = req.params;
    const updates = req.body;
    const db = getFirestore();

    await db
      .collection('Clients')
      .doc(uid)
      .collection('Family Members')
      .doc(memberId)
      .update({
        ...updates,
        updatedAt: new Date()
      });

    dualWriteFamilyMember(uid, memberId, { ...updates, updatedAt: new Date() }).catch(() => {});
    res.json({ message: 'Family member updated', memberId });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function deleteFamilyMember(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const { memberId } = req.params;
    const db = getFirestore();

    await db
      .collection('Clients')
      .doc(uid)
      .collection('Family Members')
      .doc(memberId)
      .delete();

    dualWriteDelete('family_members', 'firestore_id', memberId).catch(() => {});
    res.json({ message: 'Family member deleted', memberId });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function getAddresses(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const clientId = await resolveSupabaseClientId(uid);
    if (!clientId) {
      res.status(404).json({ error: 'Client not found' });
      return;
    }

    const { data, error } = await supabase
      .from('client_addresses')
      .select('*')
      .eq('client_id', clientId);

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    const addresses = (data ?? []).map((a: any) => ({
      addressId: a.firestore_id ?? a.id,
      ...a,
      Name: a.name ?? a.label,
      Address: a.address1,
      address: a.address1,
      fullAddress: a.address1,
      'Additional address': a.additional_info ?? a.address2,
      Appartment: a.apartment,
      Etage: a.floor,
      isPrimary: a.is_primary,
    }));
    res.json({ addresses });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function addAddress(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const addressData = req.body;
    const db = getFirestore();

    const addressRef = await db
      .collection('Clients')
      .doc(uid)
      .collection('Addresses')
      .add({
        ...addressData,
        createdAt: new Date()
      });

    dualWriteAddress(uid, addressRef.id, { ...addressData, createdAt: new Date() }).catch(() => {});
    res.status(201).json({ addressId: addressRef.id, ...addressData });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function updateAddress(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const { addressId } = req.params;
    const updates = req.body;
    const db = getFirestore();

    await db
      .collection('Clients')
      .doc(uid)
      .collection('Addresses')
      .doc(addressId)
      .update({
        ...updates,
        updatedAt: new Date()
      });

    dualWriteAddress(uid, addressId, { ...updates, updatedAt: new Date() }).catch(() => {});
    res.json({ message: 'Address updated', addressId });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function deleteAddress(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const { addressId } = req.params;
    const db = getFirestore();

    await db
      .collection('Clients')
      .doc(uid)
      .collection('Addresses')
      .doc(addressId)
      .delete();

    dualWriteDelete('client_addresses', 'firestore_id', addressId).catch(() => {});
    res.json({ message: 'Address deleted', addressId });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

