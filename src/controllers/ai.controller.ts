import type { Response } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { enhanceMessageWithOpenAI } from '../services/messageEnhance.service.js';

const ALLOWED_SOURCE = 'crm_web_ai_message_enhancer';

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export async function messageEnhance(req: AuthenticatedRequest, res: Response): Promise<void> {
  const prompt = (req.body as any)?.prompt;
  const source = (req.body as any)?.source;

  if (!isNonEmptyString(prompt)) {
    res.status(400).json({ message: 'Le champ prompt est requis.', error: 'Le champ prompt est requis.' });
    return;
  }

  // Source optionnelle, mais si fournie on la valide pour éviter les usages inattendus
  if (source !== undefined && source !== ALLOWED_SOURCE) {
    res.status(400).json({ message: 'Source invalide.', error: 'Source invalide.' });
    return;
  }

  try {
    const enhancedMessage = await enhanceMessageWithOpenAI(prompt);
    res.status(200).json({ enhancedMessage });
  } catch (err) {
    console.error('Erreur OpenAI /api/ai/message-enhance:', err);
    res.status(500).json({ message: 'Erreur OpenAI.', error: 'Erreur OpenAI.' });
  }
}


