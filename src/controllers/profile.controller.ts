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

// Mapping of all accepted incoming field keys → Supabase column, Firestore field, and Account Owner sync fields
const PROFILE_FIELD_MAP: Record<string, { supa: string; fs: string; ao?: string[] }> = {
  // snake_case (canonical)
  'first_name':     { supa: 'first_name',     fs: 'First Name',     ao: ['First Name', 'Prénom', 'Prenom', 'FirstName'] },
  'last_name':      { supa: 'last_name',      fs: 'Last Name',      ao: ['Last Name', 'Nom', 'LastName'] },
  'father_name':    { supa: 'father_name',    fs: 'Father Name' },
  'birthday':       { supa: 'birthday',       fs: 'Birthday',       ao: ['Birthday', 'Date de naissance'] },
  'teoudat_zeout':  { supa: 'teoudat_zeout',  fs: 'Teoudat Zeout',  ao: ['Teoudat Zeout', 'Teudat zeout', 'Teudat Zeout', 'Teudat zeout '] },
  'koupat_holim':   { supa: 'koupat_holim',   fs: 'Koupat Holim',   ao: ['Koupat Holim'] },
  'email':          { supa: 'email',          fs: 'Email',          ao: ['Email'] },
  'phone':          { supa: 'phone',          fs: 'Phone Number' },
  'civility':       { supa: 'civility',       fs: 'Civility' },
  'language':       { supa: 'language',       fs: 'language' },
  'profile_photo_url': { supa: 'profile_photo_url', fs: 'profilePhotoUrl' },
  // Legacy Firestore-style keys
  'First Name':     { supa: 'first_name',     fs: 'First Name',     ao: ['First Name', 'Prénom', 'Prenom', 'FirstName'] },
  'Last Name':      { supa: 'last_name',      fs: 'Last Name',      ao: ['Last Name', 'Nom', 'LastName'] },
  'Father Name':    { supa: 'father_name',    fs: 'Father Name' },
  'Birthday':       { supa: 'birthday',       fs: 'Birthday',       ao: ['Birthday', 'Date de naissance'] },
  'Teoudat Zeout':  { supa: 'teoudat_zeout',  fs: 'Teoudat Zeout',  ao: ['Teoudat Zeout', 'Teudat zeout', 'Teudat Zeout', 'Teudat zeout '] },
  'Koupat Holim':   { supa: 'koupat_holim',   fs: 'Koupat Holim',   ao: ['Koupat Holim'] },
  'Email':          { supa: 'email',          fs: 'Email',          ao: ['Email'] },
  // Client_ prefix keys (from Flutter ProfileBackendService)
  'Client_FirstName':     { supa: 'first_name',     fs: 'First Name',     ao: ['First Name', 'Prénom', 'Prenom', 'FirstName'] },
  'Client_LastName':      { supa: 'last_name',      fs: 'Last Name',      ao: ['Last Name', 'Nom', 'LastName'] },
  'Client_Birthday':      { supa: 'birthday',       fs: 'Birthday',       ao: ['Birthday', 'Date de naissance'] },
  'Client_TeoudatZeout':  { supa: 'teoudat_zeout',  fs: 'Teoudat Zeout',  ao: ['Teoudat Zeout', 'Teudat zeout', 'Teudat Zeout', 'Teudat zeout '] },
  'Client_KoupatHolim':   { supa: 'koupat_holim',   fs: 'Koupat Holim',   ao: ['Koupat Holim'] },
  'Client_Email':         { supa: 'email',          fs: 'Email',          ao: ['Email'] },
  'Client_City':          { supa: 'city',           fs: 'City' },
  'Client_PhoneNumber':   { supa: 'phone',          fs: 'Phone Number' },
  // camelCase keys (from Flutter repositories)
  'firstName':       { supa: 'first_name',     fs: 'First Name',     ao: ['First Name', 'Prénom', 'Prenom', 'FirstName'] },
  'lastName':        { supa: 'last_name',      fs: 'Last Name',      ao: ['Last Name', 'Nom', 'LastName'] },
  'fatherName':      { supa: 'father_name',    fs: 'Father Name' },
  'koupatHolim':     { supa: 'koupat_holim',   fs: 'Koupat Holim',   ao: ['Koupat Holim'] },
  'teoudatZeout':    { supa: 'teoudat_zeout',  fs: 'Teoudat Zeout',  ao: ['Teoudat Zeout', 'Teudat zeout', 'Teudat Zeout', 'Teudat zeout '] },
  'téléphone':       { supa: 'phone',          fs: 'Phone Number' },
  'registrationComplete': { supa: 'registration_complete', fs: 'registrationComplete' },
  'hasGOVAccess':    { supa: 'has_gov_access', fs: 'hasGOVAccess' },
  'profilePhotoUrl': { supa: 'profile_photo_url', fs: 'profilePhotoUrl' },
};

export async function updateProfile(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const updates = req.body;

    const supabaseUpdates: Record<string, any> = { updated_at: new Date().toISOString() };
    const firestoreUpdates: Record<string, any> = { 'Updated At': new Date() };
    const accountOwnerUpdates: Record<string, any> = {};

    for (const [key, value] of Object.entries(updates)) {
      const mapping = PROFILE_FIELD_MAP[key];
      if (mapping) {
        supabaseUpdates[mapping.supa] = value;
        firestoreUpdates[mapping.fs] = value;
        if (mapping.ao) {
          for (const aoKey of mapping.ao) {
            accountOwnerUpdates[aoKey] = value;
          }
        }
      } else {
        firestoreUpdates[key] = value;
      }
    }

    // 1. Write to Supabase (primary source of truth)
    const { error: supaErr } = await supabase
      .from('clients')
      .update(supabaseUpdates)
      .eq('firebase_uid', uid);

    if (supaErr) throw supaErr;

    // 2. Write to Firestore (best-effort backward compat)
    try {
      const db = getFirestore();
      await db.collection('Clients').doc(uid).update(firestoreUpdates);

      // Sync Account Owner family member in Firestore
      if (Object.keys(accountOwnerUpdates).length > 0) {
        const membersCol = db.collection('Clients').doc(uid).collection('Family Members');
        let snap = await membersCol
          .where('Family Member Status', 'in', ['Account Owner', 'Titulaire du compte'])
          .limit(1)
          .get();
        if (snap.empty) {
          snap = await membersCol
            .where('Status', 'in', ['Account Owner', 'Titulaire du compte'])
            .limit(1)
            .get();
        }
        for (const doc of snap.docs) {
          await doc.ref.update(accountOwnerUpdates);
        }
      }
    } catch (fsErr) {
      console.warn('[updateProfile] Firestore best-effort write failed:', fsErr);
    }

    // 3. Sync Account Owner in Supabase family_members table
    if (Object.keys(accountOwnerUpdates).length > 0) {
      try {
        const clientId = await resolveSupabaseClientId(uid);
        if (clientId) {
          const fmUpdates: Record<string, any> = { updated_at: new Date().toISOString() };
          if (supabaseUpdates.first_name !== undefined) fmUpdates.first_name = supabaseUpdates.first_name;
          if (supabaseUpdates.last_name !== undefined) fmUpdates.last_name = supabaseUpdates.last_name;
          if (supabaseUpdates.father_name !== undefined) fmUpdates.father_name = supabaseUpdates.father_name;
          if (supabaseUpdates.birthday !== undefined) fmUpdates.birthday = supabaseUpdates.birthday;
          if (supabaseUpdates.teoudat_zeout !== undefined) fmUpdates.teoudat_zeout = supabaseUpdates.teoudat_zeout;
          if (supabaseUpdates.koupat_holim !== undefined) fmUpdates.koupat_holim = supabaseUpdates.koupat_holim;
          if (supabaseUpdates.email !== undefined) fmUpdates.email = supabaseUpdates.email;

          await supabase
            .from('family_members')
            .update(fmUpdates)
            .eq('client_id', clientId)
            .eq('is_account_owner', true);
        }
      } catch (_) { /* best-effort */ }
    }

    // 4. Return updated profile from Supabase
    const { data } = await supabase
      .from('clients')
      .select('*')
      .eq('firebase_uid', uid)
      .single();

    res.json({
      uid,
      ...data,
      'First Name': data?.first_name,
      'Last Name': data?.last_name,
      'Email': data?.email,
      'Birthday': data?.birthday,
      'Teoudat Zeout': data?.teoudat_zeout,
      'Koupat Holim': data?.koupat_holim,
    });
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

    // 1. Write to Supabase (primary)
    const { error: supaErr } = await supabase
      .from('clients')
      .update({ language, updated_at: new Date().toISOString() })
      .eq('firebase_uid', uid);

    if (supaErr) throw supaErr;

    // 2. Write to Firestore (best-effort)
    try {
      const db = getFirestore();
      await db.collection('Clients').doc(uid).update({ language });
    } catch (fsErr) {
      console.warn('[updateLanguage] Firestore best-effort write failed:', fsErr);
    }

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
    const clientId = await resolveSupabaseClientId(uid);
    if (!clientId) {
      res.status(404).json({ error: 'Client not found' });
      return;
    }

    // 1. Write to Supabase (primary)
    const { data: inserted, error: supaErr } = await supabase
      .from('family_members')
      .insert({
        client_id: clientId,
        first_name: memberData['First Name'] ?? memberData['Prénom'] ?? memberData.first_name ?? memberData.firstName,
        last_name: memberData['Last Name'] ?? memberData['Nom'] ?? memberData.last_name ?? memberData.lastName,
        father_name: memberData['Father Name'] ?? memberData['Père'] ?? memberData.father_name ?? memberData.fatherName,
        birthday: memberData['Birthday'] ?? memberData['Date de naissance'] ?? memberData.birthday,
        teoudat_zeout: memberData['Teoudat Zeout'] ?? memberData['Teudat zeout'] ?? memberData.teoudat_zeout ?? memberData.teoudatZeout,
        koupat_holim: memberData['Koupat Holim'] ?? memberData.koupat_holim ?? memberData.koupatHolim,
        email: memberData['Email'] ?? memberData.email,
        phone: memberData.phone ?? memberData.téléphone,
        status: memberData['Family Member Status'] ?? memberData.status ?? memberData.relationship,
        relationship_type: memberData.relationship_type ?? memberData.relationshipType ?? memberData['Family Member Status'] ?? memberData.status,
        is_account_owner: memberData.isAccountOwner ?? false,
        is_active: memberData.isActive ?? true,
        metadata: {},
      })
      .select()
      .single();

    if (supaErr) throw supaErr;

    // 2. Write to Firestore (best-effort)
    try {
      const db = getFirestore();
      await db
        .collection('Clients')
        .doc(uid)
        .collection('Family Members')
        .add({ ...memberData, createdAt: new Date() });
    } catch (fsErr) {
      console.warn('[addFamilyMember] Firestore best-effort write failed:', fsErr);
    }

    res.status(201).json({ memberId: inserted?.id, ...inserted });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function updateFamilyMember(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const { memberId } = req.params;
    const updates = req.body;

    // Build Supabase update payload (supports snake_case, PascalCase, and French keys)
    const supaUpdates: Record<string, any> = { updated_at: new Date().toISOString() };
    const fn = updates.first_name ?? updates['First Name'] ?? updates['Prénom'] ?? updates.firstName;
    if (fn !== undefined) supaUpdates.first_name = fn;
    const ln = updates.last_name ?? updates['Last Name'] ?? updates['Nom'] ?? updates.lastName;
    if (ln !== undefined) supaUpdates.last_name = ln;
    const fan = updates.father_name ?? updates['Father Name'] ?? updates['Père'] ?? updates.fatherName;
    if (fan !== undefined) supaUpdates.father_name = fan;
    const bd = updates.birthday ?? updates['Birthday'] ?? updates['Date de naissance'];
    if (bd !== undefined) supaUpdates.birthday = bd;
    const tz = updates.teoudat_zeout ?? updates['Teoudat Zeout'] ?? updates['Teudat zeout'] ?? updates.teoudatZeout;
    if (tz !== undefined) supaUpdates.teoudat_zeout = tz;
    const kh = updates.koupat_holim ?? updates['Koupat Holim'] ?? updates.koupatHolim;
    if (kh !== undefined) supaUpdates.koupat_holim = kh;
    if (updates.civility !== undefined) supaUpdates.civility = updates.civility;
    if (updates.email !== undefined) supaUpdates.email = updates.email;
    if (updates.phone !== undefined) supaUpdates.phone = updates.phone;
    if (updates.status !== undefined) supaUpdates.status = updates.status;
    if (updates.relationship_type !== undefined) supaUpdates.relationship_type = updates.relationship_type;
    if (updates.is_account_owner !== undefined) supaUpdates.is_account_owner = updates.is_account_owner;
    if (updates.has_gov_access !== undefined) supaUpdates.has_gov_access = updates.has_gov_access;
    if (updates.is_active !== undefined) supaUpdates.is_active = updates.is_active;

    // Update Supabase (primary source of truth)
    const { error: supaErr } = await supabase
      .from('family_members')
      .update(supaUpdates)
      .or(`id.eq.${memberId},firestore_id.eq.${memberId}`);

    if (supaErr) throw supaErr;

    // Best-effort Firestore update (may fail if doc doesn't exist there)
    try {
      const db = getFirestore();
      await db
        .collection('Clients')
        .doc(uid)
        .collection('Family Members')
        .doc(memberId)
        .update({ ...updates, updatedAt: new Date() });
    } catch (_) { /* Firestore doc might not exist – that's OK */ }

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
    const clientId = await resolveSupabaseClientId(uid);
    if (!clientId) {
      res.status(404).json({ error: 'Client not found' });
      return;
    }

    // 1. Write to Supabase (primary)
    const { data: inserted, error: supaErr } = await supabase
      .from('client_addresses')
      .insert({
        client_id: clientId,
        name: addressData.name ?? addressData.Name,
        label: addressData.name ?? addressData.Name,
        address1: addressData.address ?? addressData.Address,
        address2: addressData.additionalInfo ?? addressData['Additional address'],
        additional_info: addressData.additionalInfo ?? addressData['Additional address'],
        apartment: addressData.apartment ?? addressData.Appartment,
        floor: addressData.floor ?? addressData.Etage,
        details: addressData.details,
        is_active: true,
        order_index: addressData.orderIndex ?? 0,
        metadata: addressData.paymentInfo ? { paymentInfo: addressData.paymentInfo } : {},
      })
      .select()
      .single();

    if (supaErr) throw supaErr;

    // 2. Write to Firestore (best-effort)
    try {
      const db = getFirestore();
      await db
        .collection('Clients')
        .doc(uid)
        .collection('Addresses')
        .add({ ...addressData, createdAt: new Date() });
    } catch (fsErr) {
      console.warn('[addAddress] Firestore best-effort write failed:', fsErr);
    }

    res.status(201).json({ addressId: inserted?.id, ...inserted });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function updateAddress(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const { addressId } = req.params;
    const updates = req.body;

    // Build Supabase update payload
    const supaUpdates: Record<string, any> = { updated_at: new Date().toISOString() };
    if (updates.name !== undefined) { supaUpdates.name = updates.name; supaUpdates.label = updates.name; }
    if (updates.address !== undefined) supaUpdates.address1 = updates.address;
    if (updates.additionalInfo !== undefined) { supaUpdates.address2 = updates.additionalInfo; supaUpdates.additional_info = updates.additionalInfo; }
    if (updates.apartment !== undefined) supaUpdates.apartment = updates.apartment;
    if (updates.floor !== undefined) supaUpdates.floor = updates.floor;
    if (updates.details !== undefined) supaUpdates.details = updates.details;
    if (updates.isPrimary !== undefined) supaUpdates.is_primary = updates.isPrimary;

    // 1. Write to Supabase (primary)
    const { error: supaErr } = await supabase
      .from('client_addresses')
      .update(supaUpdates)
      .or(`id.eq.${addressId},firestore_id.eq.${addressId}`);

    if (supaErr) throw supaErr;

    // 2. Write to Firestore (best-effort)
    try {
      const db = getFirestore();
      await db
        .collection('Clients')
        .doc(uid)
        .collection('Addresses')
        .doc(addressId)
        .update({ ...updates, updatedAt: new Date() });
    } catch (_) { /* Firestore doc might not exist */ }

    res.json({ message: 'Address updated', addressId });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function deleteAddress(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const { addressId } = req.params;

    // 1. Delete from Supabase (primary)
    const { error: supaErr } = await supabase
      .from('client_addresses')
      .delete()
      .or(`id.eq.${addressId},firestore_id.eq.${addressId}`);

    if (supaErr) throw supaErr;

    // 2. Delete from Firestore (best-effort)
    try {
      const db = getFirestore();
      await db
        .collection('Clients')
        .doc(uid)
        .collection('Addresses')
        .doc(addressId)
        .delete();
    } catch (_) { /* best-effort */ }

    res.json({ message: 'Address deleted', addressId });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

