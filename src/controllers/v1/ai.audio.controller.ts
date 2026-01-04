import type { Response } from 'express';
import busboy from '@fastify/busboy';
import type { AuthenticatedRequest } from '../../middleware/auth.middleware.js';
import { consumeRateLimit } from '../../services/rateLimit.service.js';

const MAX_FILE_BYTES = 25 * 1024 * 1024;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

async function parseAudioMultipart(req: AuthenticatedRequest): Promise<{
  file: { buffer: Buffer; filename: string; mimeType: string };
  language?: string;
}> {
  const contentType = req.headers['content-type'] || '';
  if (typeof contentType !== 'string' || !contentType.toLowerCase().includes('multipart/form-data')) {
    throw Object.assign(new Error('bad_multipart'), { code: 'BAD_MULTIPART' as const });
  }

  const bb: any = (busboy as any)({
    headers: req.headers,
    limits: { files: 1, fields: 10, fileSize: MAX_FILE_BYTES }
  });

  let language: string | undefined;
  let fileBuffer: Buffer | undefined;
  let fileName = 'audio';
  let mimeType = 'application/octet-stream';
  let fileTooLarge = false;

  bb.on('field', (name: string, value: any) => {
    if (name === 'language' && isNonEmptyString(value)) {
      language = value.trim();
    }
  });

  bb.on('file', (name: string, stream: any, info: any) => {
    if (name !== 'file') {
      // On ignore les autres champs fichiers
      stream.resume();
      return;
    }

    fileName = info?.filename || fileName;
    mimeType = info?.mimeType || info?.mimetype || mimeType;

    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    stream.on('limit', () => {
      fileTooLarge = true;
      stream.resume();
    });
    stream.on('end', () => {
      if (!fileTooLarge) {
        fileBuffer = Buffer.concat(chunks);
      }
    });
  });

  return await new Promise((resolve, reject) => {
    bb.on('error', (err: any) => reject(err));
    bb.on('finish', () => {
      if (fileTooLarge) {
        reject(Object.assign(new Error('file_too_large'), { code: 'FILE_TOO_LARGE' as const }));
        return;
      }
      if (!fileBuffer || fileBuffer.length === 0) {
        reject(Object.assign(new Error('invalid_audio'), { code: 'INVALID_AUDIO' as const }));
        return;
      }
      resolve({ file: { buffer: fileBuffer, filename: fileName, mimeType }, language });
    });
    (req as any).pipe(bb);
  });
}

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

  let parsed: { file: { buffer: Buffer; filename: string; mimeType: string }; language?: string };
  try {
    parsed = await parseAudioMultipart(req);
  } catch (e: any) {
    if (e?.code === 'FILE_TOO_LARGE') {
      res.status(413).json({ message: 'Fichier trop volumineux (max 25MB).' });
      return;
    }
    // multipart manquant/invalide ou fichier absent
    res.status(400).json({ message: 'Fichier audio invalide.' });
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
    const audioBlob = new Blob([parsed.file.buffer], { type: parsed.file.mimeType });
    form.append('file', audioBlob, parsed.file.filename || 'audio');
    if (isNonEmptyString(parsed.language)) {
      form.append('language', parsed.language.trim());
    }

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


