import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { supabase } from '../services/supabase.service.js';
import { getJsonFromCache, setJsonInCache } from '../services/cache.service.js';

const AI_KEY_CACHE_KEY = 'utils:openai:key';
const AI_KEY_CACHE_TTL = 300; // 5 minutes

export async function getMembershipDetails(
  req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  try {
    const { data, error } = await supabase
      .from('app_config')
      .select('value')
      .eq('key', 'membership_details')
      .maybeSingle();

    if (error) throw error;

    res.json({ details: data?.value ?? {} });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function getServiceAvailability(
  req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  try {
    const { data, error } = await supabase
      .from('app_config')
      .select('value')
      .eq('key', 'urgency')
      .maybeSingle();

    if (error) throw error;

    res.json({ availability: data?.value ?? {} });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function getRelationshipTypes(
  req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  try {
    const { data, error } = await supabase
      .from('relationship_types')
      .select('id, slug, label, display_order')
      .order('display_order', { ascending: true });

    if (error) throw error;

    res.json({ types: data ?? [] });
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

    const { data, error } = await supabase
      .from('app_config')
      .select('value')
      .eq('key', 'openai')
      .maybeSingle();

    if (error) throw error;

    const key = (data?.value as any)?.key ?? null;

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
