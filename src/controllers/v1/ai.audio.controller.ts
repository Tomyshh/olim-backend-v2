import type { Response } from 'express';
import type { AuthenticatedRequest } from '../../middleware/auth.middleware.js';
import { consumeRateLimit } from '../../services/rateLimit.service.js';

const MAX_FILE_BYTES = 25 * 1024 * 1024;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

type UploadedFile = {
  buffer: Buffer;
  size: number;
  originalname?: string;
  mimetype?: string;
};
type TranscriptionRequest = AuthenticatedRequest & { file?: UploadedFile; body: any };

export async function v1AudioTranscription(req: AuthenticatedRequest, res: Response): Promise<void> {
  // Auth obligatoire : si jamais le middleware n'a pas posé uid, on force 401 au format attendu
  if (!req.uid) {
    res.status(401).json({ message: 'Vous devez être connecté.' });
    return;
  }

  // Optionnel : rate limit par uid pour éviter abus
  try {
    const rl = await consumeRateLimit({
      key: `rl:transcriptions:${req.uid}`,
      limit: 30,
      windowSeconds: 60
    });
    if (!rl.allowed) {
      res.status(429).json({ message: 'Trop de requêtes.' });
      return;
    }
  } catch (e) {
    // Si Redis est KO, on ne bloque pas l'endpoint
    console.warn('Rate-limit transcriptions: erreur (ignorée):', e);
  }

  const r = req as TranscriptionRequest;
  const file = r.file;
  const languageRaw = r.body?.language;
  const language = isNonEmptyString(languageRaw) ? languageRaw.trim() : undefined;

  if (!file || !Buffer.isBuffer(file.buffer) || file.buffer.length === 0) {
    res.status(400).json({ message: 'Fichier audio invalide.' });
    return;
  }
  if (file.size > MAX_FILE_BYTES) {
    // Normalement géré par multer (LIMIT_FILE_SIZE), mais on garde une garde-fou
    res.status(413).json({ message: 'Fichier trop volumineux (max 25MB).' });
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!isNonEmptyString(apiKey)) {
    console.error('OPENAI_API_KEY manquant');
    res.status(500).json({ message: 'Erreur transcription.' });
    return;
  }

  try {
    const form = new FormData();
    form.append('model', 'whisper-1');
    const audioBlob = new Blob([file.buffer], { type: file.mimetype || 'application/octet-stream' });
    form.append('file', audioBlob, file.originalname || 'audio');
    if (isNonEmptyString(language)) form.append('language', language);

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`
      },
      body: form
    });

    if (!response.ok) {
      if (response.status === 429) {
        res.status(429).json({ message: 'Trop de requêtes.' });
        return;
      }
      if (response.status === 413) {
        res.status(413).json({ message: 'Fichier trop volumineux (max 25MB).' });
        return;
      }
      if (response.status === 400) {
        res.status(400).json({ message: 'Fichier audio invalide.' });
        return;
      }

      const bodyText = await response.text().catch(() => '');
      console.error('Erreur Whisper:', response.status, bodyText);
      res.status(500).json({ message: 'Erreur transcription.' });
      return;
    }

    const data: any = await response.json();
    const text = data?.text;
    res.status(200).json({ text: typeof text === 'string' ? text : '' });
  } catch (err) {
    console.error('Erreur transcription:', err);
    res.status(500).json({ message: 'Erreur transcription.' });
  }
}


