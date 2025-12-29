export type PhoneNormalizeResult =
  | { ok: true; e164: string; digitsOnly: string }
  | { ok: false; message: string };

/**
 * Normalisation minimale E.164 (sans dépendance externe):
 * - doit commencer par "+"
 * - uniquement chiffres après "+"
 * - longueur 8..15 chiffres (règle E.164)
 */
export function normalizeE164PhoneNumber(input: unknown): PhoneNormalizeResult {
  if (typeof input !== 'string') {
    return { ok: false, message: 'Numéro de téléphone invalide.' };
  }

  const trimmed = input.trim();
  if (!trimmed.startsWith('+')) {
    return { ok: false, message: 'Numéro de téléphone invalide.' };
  }

  const digits = trimmed.replace(/[^\d]/g, '');
  if (digits.length < 8 || digits.length > 15) {
    return { ok: false, message: 'Numéro de téléphone invalide.' };
  }

  const e164 = `+${digits}`;
  return { ok: true, e164, digitsOnly: digits };
}


