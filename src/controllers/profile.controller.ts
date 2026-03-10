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

    res.json({ uid, ...data });
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

    const isComplete = data.registration_complete === true;
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

    const members = (data ?? []).map(m => ({ memberId: m.firestore_id ?? m.id, ...m }));
    res.json({ members });
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

    const addresses = (data ?? []).map(a => ({ addressId: a.firestore_id ?? a.id, ...a }));
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

