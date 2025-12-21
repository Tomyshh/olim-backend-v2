import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { getFirestore } from '../config/firebase.js';

export async function getProfile(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const db = getFirestore();
    const clientDoc = await db.collection('Clients').doc(uid).get();

    if (!clientDoc.exists) {
      res.status(404).json({ error: 'Profile not found' });
      return;
    }

    res.json({ uid, ...clientDoc.data() });
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
    res.json({ uid, ...updatedDoc.data() });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function checkProfileComplete(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const db = getFirestore();
    const clientDoc = await db.collection('Clients').doc(uid).get();

    if (!clientDoc.exists) {
      res.status(404).json({ error: 'Profile not found' });
      return;
    }

    const data = clientDoc.data()!;
    const isComplete = data.registrationComplete === true;

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

    res.json({ message: 'Language updated', language });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function getFamilyMembers(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const db = getFirestore();
    const membersSnapshot = await db
      .collection('Clients')
      .doc(uid)
      .collection('Family Members')
      .get();

    const members = membersSnapshot.docs.map(doc => ({
      memberId: doc.id,
      ...doc.data()
    }));

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

    res.json({ message: 'Family member deleted', memberId });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function getAddresses(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const db = getFirestore();
    const addressesSnapshot = await db
      .collection('Clients')
      .doc(uid)
      .collection('Addresses')
      .get();

    const addresses = addressesSnapshot.docs.map(doc => ({
      addressId: doc.id,
      ...doc.data()
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

    res.json({ message: 'Address deleted', addressId });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

