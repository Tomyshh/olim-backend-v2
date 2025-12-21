import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { getFirestore, getStorage } from '../config/firebase.js';

export async function getDocuments(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const db = getFirestore();

    // Documents personnels (nouvelle structure)
    const personalDocsSnapshot = await db
      .collection('Clients')
      .doc(uid)
      .collection('Docs')
      .doc('Personnels')
      .get();

    // Documents legacy
    const legacyDocsSnapshot = await db
      .collection('Clients')
      .doc(uid)
      .collection('Client Documents')
      .get();

    const personalDocs = personalDocsSnapshot.exists ? [personalDocsSnapshot.data()] : [];
    const legacyDocs = legacyDocsSnapshot.docs.map(doc => ({
      documentId: doc.id,
      ...doc.data()
    }));

    res.json({ personalDocs, legacyDocs });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function getPersonalDocuments(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const db = getFirestore();

    // Nouvelle structure: Clients/{uid}/Docs/Personnels
    const personalDoc = await db
      .collection('Clients')
      .doc(uid)
      .collection('Docs')
      .doc('Personnels')
      .get();

    if (!personalDoc.exists) {
      res.json({ documents: [] });
      return;
    }

    res.json({ documents: personalDoc.data() });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function getFamilyMemberDocuments(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const { memberId } = req.params;
    const db = getFirestore();

    const memberDocs = await db
      .collection('Clients')
      .doc(uid)
      .collection('membres')
      .doc(memberId)
      .collection('Docs')
      .doc('Personnels')
      .get();

    if (!memberDocs.exists) {
      res.json({ documents: [] });
      return;
    }

    res.json({ documents: memberDocs.data() });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function uploadPersonalDocument(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const { type, typeKey, fileName } = req.body;
    // TODO: Implémenter upload avec Firebase Storage
    // TODO: Stocker dans Clients/{uid}/docs/{typeKey}/...
    // TODO: Mettre à jour Firestore

    res.status(501).json({
      message: 'Not implemented - uploadPersonalDocument',
      note: 'À implémenter avec Firebase Storage + Firestore update'
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function uploadFamilyMemberDocument(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const { memberId } = req.params;
    const { type, typeKey, fileName } = req.body;
    // TODO: Implémenter upload avec Firebase Storage
    // TODO: Stocker dans Clients/{uid}/membres/{memberId}/docs/{typeKey}/...

    res.status(501).json({
      message: 'Not implemented - uploadFamilyMemberDocument',
      note: 'À implémenter avec Firebase Storage'
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function downloadDocument(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const { documentId } = req.params;
    // TODO: Récupérer document depuis Storage
    // TODO: Streamer le fichier

    res.status(501).json({
      message: 'Not implemented - downloadDocument',
      note: 'À implémenter avec Firebase Storage download'
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function deleteDocument(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const { documentId } = req.params;
    // TODO: Supprimer depuis Storage
    // TODO: Supprimer référence Firestore

    res.status(501).json({
      message: 'Not implemented - deleteDocument',
      note: 'À implémenter avec Firebase Storage + Firestore delete'
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

