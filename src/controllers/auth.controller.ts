import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { getFirestore, getAuth } from '../config/firebase.js';

// ⚠️ STUB - À implémenter avec Vonage OTP
export async function sendPhoneOtp(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { phoneNumber } = req.body;
    const uid = req.uid!;

    // TODO: Implémenter appel Vonage OTP
    // TODO: Stocker dans PhoneOtpRequests/{requestId}
    
    res.status(501).json({
      message: 'Not implemented - sendPhoneOtp',
      note: 'À implémenter avec Vonage OTP service'
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function verifyPhoneOtpAndLink(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { phoneNumber, otpCode } = req.body;
    const uid = req.uid!;

    // TODO: Vérifier OTP avec Vonage
    // TODO: Lier téléphone au compte Firebase Auth
    // TODO: Mettre à jour Clients/{uid}
    
    res.status(501).json({
      message: 'Not implemented - verifyPhoneOtpAndLink',
      note: 'À implémenter avec Vonage OTP verification'
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function sendLoginPhoneOtp(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { phoneNumber } = req.body;

    // TODO: Implémenter appel Vonage OTP (sans auth)
    // TODO: Stocker dans PhoneOtpLogin/{requestId}
    
    res.status(501).json({
      message: 'Not implemented - sendLoginPhoneOtp',
      note: 'À implémenter avec Vonage OTP service'
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function verifyLoginPhoneOtp(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { phoneNumber, otpCode } = req.body;

    // TODO: Vérifier OTP avec Vonage
    // TODO: Créer ou récupérer utilisateur
    // TODO: Générer customToken avec Firebase Admin
    // TODO: Retourner customToken
    
    res.status(501).json({
      message: 'Not implemented - verifyLoginPhoneOtp',
      note: 'À implémenter avec Vonage OTP + customToken generation'
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function createVisitorAccount(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { email, phoneNumber, firstName, lastName } = req.body;

    // TODO: Créer compte Firebase Auth (visitor)
    // TODO: Créer document Clients/{uid} avec structure complète
    // TODO: Initialiser sous-collections de base
    
    res.status(501).json({
      message: 'Not implemented - createVisitorAccount',
      note: 'À implémenter avec Firebase Auth + Firestore structure'
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function loginEmail(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { email, password } = req.body;

    // TODO: Vérifier credentials (si stockés dans Firestore ou Firebase Auth)
    // TODO: Générer customToken ou retourner token Firebase
    
    res.status(501).json({
      message: 'Not implemented - loginEmail',
      note: 'À implémenter selon stratégie auth email/password'
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

