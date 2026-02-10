import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { computeMembershipPricing } from '../services/membershipPricing.service.js';
import {
  loadPromotionByCode,
  digitsOnlyUpper,
  timestampToDate,
  isPromoActive
} from '../services/promoCode.service.js';

function pickString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * POST /api/promo/validate
 * Valide un code promo et retourne les informations de réduction.
 */
export async function validatePromoCode(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const body = (req.body || {}) as {
      code?: unknown;
      membershipType?: unknown;
      plan?: unknown;
      customPriceInCents?: unknown;
    };

    const codeRaw = pickString(body.code);
    const membershipType = pickString(body.membershipType);
    const plan = pickString(body.plan);
    // Prix custom optionnel (ex: prix défini manuellement par le conseiller dans le CRM)
    const customPriceRaw = typeof body.customPriceInCents === 'number' ? body.customPriceInCents
      : typeof body.customPriceInCents === 'string' ? Number(body.customPriceInCents) : NaN;
    const customPriceInCents = Number.isFinite(customPriceRaw) && customPriceRaw > 0 ? Math.floor(customPriceRaw) : null;

    if (!codeRaw) {
      res.status(200).json({ valid: false, error: 'Code requis.', errorType: 'invalid_code' });
      return;
    }

    // Normaliser le code
    const codeNormalized = digitsOnlyUpper(codeRaw);
    if (!codeNormalized) {
      res.status(200).json({ valid: false, error: 'Code invalide ou expiré', errorType: 'invalid_code' });
      return;
    }

    // Charger la promotion depuis Firestore
    const promotion = await loadPromotionByCode(codeNormalized);
    if (!promotion) {
      res.status(200).json({ valid: false, error: 'Code invalide ou expiré', errorType: 'invalid_code' });
      return;
    }

    const doc = promotion.data;

    // Vérifier isValid / active / enabled
    if (!isPromoActive(doc)) {
      res.status(200).json({ valid: false, error: 'Code invalide ou expiré', errorType: 'invalid_code' });
      return;
    }

    // Vérifier l'expiration
    const expiresAt = timestampToDate(doc.expirationDate ?? doc.expiresAt ?? doc.expiryDate);
    if (expiresAt && expiresAt.getTime() < Date.now()) {
      res.status(200).json({ valid: false, error: 'Code expiré', errorType: 'expired' });
      return;
    }

    // Vérifier la compatibilité membershipType
    const promoMembershipType = pickString(doc.membershipType) || 'any';
    if (promoMembershipType.toLowerCase() !== 'any' && membershipType) {
      if (promoMembershipType !== membershipType) {
        res.status(200).json({
          valid: false,
          error: `Ce code est valable uniquement pour ${promoMembershipType}`,
          errorType: 'wrong_membership',
          expectedMembershipType: promoMembershipType
        });
        return;
      }
    }

    // Extraire la réduction (pourcentage)
    const reductionRaw = doc.reduction ?? doc.percentOff ?? doc.discountPercent ?? doc.reductionPercent ?? doc.percent ?? doc.pct;
    const reduction = typeof reductionRaw === 'number' ? reductionRaw : (typeof reductionRaw === 'string' ? Number(reductionRaw.trim()) : 0);
    const isFreeCode = reduction === 100;

    // Durée de la promotion
    const promoDurationRaw = doc.promo_duration ?? doc.promoDuration ?? doc.durationCycles ?? doc.duration;
    const promoDuration = typeof promoDurationRaw === 'number' ? promoDurationRaw : (typeof promoDurationRaw === 'string' ? Number(promoDurationRaw.trim()) : 0);

    // Source
    const source = pickString(doc.source) || codeNormalized;

    // Calculer le prix original et réduit
    // Priorité: customPriceInCents (prix admin) > Remote Config > fallback
    let originalPriceInCents = 0;
    let discountedPriceInCents = 0;

    if (customPriceInCents) {
      originalPriceInCents = customPriceInCents;
      discountedPriceInCents = Math.max(0, Math.round(originalPriceInCents - (originalPriceInCents * reduction / 100)));
    } else if (membershipType && plan) {
      const pricing = await computeMembershipPricing({ membershipType, plan });
      if (pricing.ok) {
        originalPriceInCents = pricing.serverPriceInCents;
        discountedPriceInCents = Math.max(0, Math.round(originalPriceInCents - (originalPriceInCents * reduction / 100)));
      }
    }

    res.status(200).json({
      valid: true,
      code: codeNormalized,
      reduction: Number.isFinite(reduction) ? reduction : 0,
      isFreeCode,
      membershipType: promoMembershipType,
      source,
      expirationDate: expiresAt ? expiresAt.toISOString() : null,
      promoDuration: Number.isFinite(promoDuration) ? promoDuration : 0,
      discountedPriceInCents,
      originalPriceInCents
    });
  } catch (error: any) {
    console.error('[promo/validate] Error:', error);
    res.status(500).json({ valid: false, error: 'Erreur serveur.', errorType: 'auth_error' });
  }
}
