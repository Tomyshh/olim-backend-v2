/**
 * Port backend de ProcessTimeUtils (Flutter) : calculateAdjustedProcessTime
 * Objectif: coller au comportement Flutter (parsing + facteurs + arrondis/conversions).
 */

export type Membership = string | null | undefined;

const WORD_TO_NUMBER: Record<string, number> = {
  un: 1,
  une: 1,
  deux: 2,
  trois: 3,
  quatre: 4,
  cinq: 5,
  six: 6,
  sept: 7,
  huit: 8,
  neuf: 9,
  dix: 10
};

type ParsedTime = { value: number; unit: string; prefix?: string };

function normalizeMembership(membership: Membership): string | null {
  if (!membership) return null;
  return String(membership).trim();
}

function reductionFactorForMembership(membership: Membership): number | null {
  const m = normalizeMembership(membership);
  if (!m) return null;

  // EXACT: null/Pack Start/Visitor => inchangé
  if (m === 'Pack Start' || m === 'Visitor') return null;

  // Tolérance: certaines variantes sans espaces/casse
  const mKey = m.toLowerCase().replace(/\s+/g, '');
  if (m === 'Pack Essential' || mKey === 'packessential') return 0.8;
  if (m === 'Pack VIP' || mKey === 'packvip') return 0.6;
  if (m === 'Pack Elite' || mKey === 'packelite') return 0.4;

  return null;
}

function wordToNumber(word: string): number | null {
  const w = word.toLowerCase();
  return WORD_TO_NUMBER[w] ?? null;
}

function parseTimeString(timeString: string): ParsedTime | null {
  if (!timeString) return null;
  const normalized = timeString.toLowerCase().trim();
  if (!normalized) return null;

  // Format simple: "3 jours", "2 semaines", etc.
  const simple = /^(\d+)\s+(jour|jours|semaine|semaines|mois|heure|heures)$/;
  const sm = normalized.match(simple);
  if (sm) {
    return { value: parseInt(sm[1]!, 10), unit: sm[2]! };
  }

  // Format plage: "1-2 jours", "2-3 semaines"
  const range = /^(\d+)\s*-\s*(\d+)\s+(jour|jours|semaine|semaines|mois|heure|heures)$/;
  const rm = normalized.match(range);
  if (rm) {
    const maxValue = parseInt(rm[2]!, 10);
    return { value: maxValue, unit: rm[3]!, prefix: `${rm[1]!}-` };
  }

  // Format avec "à": "deux à quatre semaines"
  const aPattern = /^(\w+)\s+à\s+(\w+)\s+(jour|jours|semaine|semaines|mois|heure|heures)$/;
  const am = normalized.match(aPattern);
  if (am) {
    const firstWord = am[1]!;
    const secondWord = am[2]!;
    const unit = am[3]!;
    const firstNum = wordToNumber(firstWord);
    const secondNum = wordToNumber(secondWord);
    if (firstNum !== null && secondNum !== null) {
      return { value: secondNum, unit, prefix: `${firstWord} à ` };
    }
  }

  // Fallback: extraire un nombre + détecter unité si la string contient jour|semaine|mois|heure
  const numMatch = normalized.match(/\d+/);
  if (numMatch) {
    const value = parseInt(numMatch[0]!, 10);
    let unit: string | null = null;
    if (normalized.includes('jour')) unit = 'jours';
    else if (normalized.includes('semaine')) unit = 'semaines';
    else if (normalized.includes('mois')) unit = 'mois';
    else if (normalized.includes('heure')) unit = 'heures';

    if (unit) return { value, unit };
  }

  return null;
}

function formatTimeString(value: number, unit: string, prefix: string): string {
  const finalValue = value < 1 ? 1 : value;

  let finalUnit = unit;
  if (finalValue > 1 && !unit.endsWith('s')) {
    if (unit === 'jour') finalUnit = 'jours';
    else if (unit === 'semaine') finalUnit = 'semaines';
    else if (unit === 'heure') finalUnit = 'heures';
  } else if (finalValue === 1 && unit.endsWith('s')) {
    if (unit === 'jours') finalUnit = 'jour';
    else if (unit === 'semaines') finalUnit = 'semaine';
    else if (unit === 'heures') finalUnit = 'heure';
  }

  return `${prefix}${finalValue} ${finalUnit}`;
}

function adjustTimeString(timeString: string, membership: string): string {
  let reductionFactor: number;
  switch (membership) {
    case 'Pack Essential':
      reductionFactor = 0.8;
      break;
    case 'Pack VIP':
      reductionFactor = 0.6;
      break;
    case 'Pack Elite':
      reductionFactor = 0.4;
      break;
    default:
      // Tolérance (variantes)
      {
        const k = membership.toLowerCase().replace(/\s+/g, '');
        if (k === 'packessential') reductionFactor = 0.8;
        else if (k === 'packvip') reductionFactor = 0.6;
        else if (k === 'packelite') reductionFactor = 0.4;
        else return timeString;
      }
  }

  const timeData = parseTimeString(timeString);
  if (!timeData) return timeString;

  const baseValue = timeData.value;
  const calculatedValue = baseValue * reductionFactor;
  const unit = timeData.unit;
  const prefix = timeData.prefix ?? '';

  // Conversion spéciale: < 1 jour => heures (sans prefix)
  if (calculatedValue < 1.0 && (unit === 'jour' || unit === 'jours')) {
    const hours = Math.ceil(calculatedValue * 24);
    if (hours >= 1) {
      return formatTimeString(hours, 'heures', '');
    }
  }

  const newValue = Math.ceil(calculatedValue);
  return formatTimeString(newValue, unit, prefix);
}

/**
 * Equivalent Flutter:
 * ProcessTimeUtils.calculateAdjustedProcessTime(baseProcessTime, membership)
 */
export function calculateAdjustedProcessTime(baseProcessTime: string, membership: Membership): string {
  const m = normalizeMembership(membership);
  if (!m || m === 'Pack Start' || m === 'Visitor') return baseProcessTime;

  const factor = reductionFactorForMembership(m);
  if (factor === null) return baseProcessTime;

  // IMPORTANT: on réutilise adjustTimeString pour coller au comportement Flutter.
  // (Le facteur est choisi via membership; ici on passe membership tel quel.)
  return adjustTimeString(baseProcessTime, m);
}

