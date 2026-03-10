import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { getFirestore } from '../config/firebase.js';
import { getJsonFromCache, setJsonInCache } from '../services/cache.service.js';

const AI_KEY_CACHE_KEY = 'utils:openai:key';
const AI_KEY_CACHE_TTL = 300; // 5 minutes

export async function getMembershipDetails(
  req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  try {
    const db = getFirestore();
    const doc = await db.collection('Utils').doc('membership_details').get();
    const data = doc.exists ? doc.data() ?? {} : {};
    res.json({ details: data });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function getServiceAvailability(
  req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  try {
    const db = getFirestore();
    const doc = await db.collection('Utils').doc('urgency').get();
    const data = doc.exists ? doc.data() ?? {} : {};
    res.json({ availability: data });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function getAiKey(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const cached = await getJsonFromCache<string>(AI_KEY_CACHE_KEY);
    if (cached) {
      res.json({ apiKey: cached });
      return;
    }

    const db = getFirestore();
    const doc = await db.collection('Utils').doc('openai').get();
    const data = doc.exists ? doc.data() ?? {} : {};
    const key = (data as any).key ?? null;

    if (key) {
      try {
        await setJsonInCache(AI_KEY_CACHE_KEY, key, AI_KEY_CACHE_TTL);
      } catch {
        // Don't fail if Redis unavailable
      }
    }

    res.json({ apiKey: key });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}
