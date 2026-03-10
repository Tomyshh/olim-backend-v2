import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { supabase } from '../services/supabase.service.js';

type PartnerRow = {
  id?: string;
  firestore_id?: string | null;
  title?: string | null;
  description?: string | null;
  vip_sentence?: string | null;
  address?: string | null;
  adresse?: string | null;
  category?: string | null;
  categorie?: string | null;
  partner_type?: string | null;
  waze?: string | null;
  is_active?: boolean | null;
  is_vip?: boolean | null;
  vip?: boolean | null;
  keywords?: unknown;
  subtitle?: unknown;
  villes?: unknown;
  langues?: unknown;
  images?: unknown;
  icon?: string | null;
  icon_vip?: string | null;
  metadata?: Record<string, any> | null;
};

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item ?? '').trim())
    .filter(Boolean);
}

function toLegacyPartner(row: PartnerRow) {
  const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
  const images = row.images && typeof row.images === 'object'
    ? row.images
    : ((metadata as any).Images && typeof (metadata as any).Images === 'object'
        ? (metadata as any).Images
        : {});

  return {
    partnerId: row.firestore_id || row.id || '',
    docID: row.firestore_id || row.id || '',
    id: row.firestore_id || row.id || '',
    firestore_id: row.firestore_id || null,
    title: row.title || (metadata as any).title || '',
    description: row.description || (metadata as any).description || '',
    VIPsentence: row.vip_sentence || (metadata as any).VIPsentence || '',
    adresse: row.adresse || row.address || (metadata as any).adresse || (metadata as any).address || '',
    categorie: row.categorie || row.category || (metadata as any).categorie || (metadata as any).category || '',
    partnerType: row.partner_type || (metadata as any).partnerType || (metadata as any).type || '',
    waze: row.waze || (metadata as any).waze || '',
    wazeURL: row.waze || (metadata as any).waze || '',
    VIP: row.is_vip === true || row.vip === true,
    is_vip: row.is_vip === true || row.vip === true,
    vip: row.vip === true || row.is_vip === true,
    isActive: row.is_active !== false,
    is_active: row.is_active !== false,
    keywords: Array.isArray(row.keywords) ? row.keywords : toStringArray((metadata as any).keywords),
    subtitle: Array.isArray(row.subtitle) ? row.subtitle : toStringArray((metadata as any).subtitle),
    villes: Array.isArray(row.villes) ? row.villes : toStringArray((metadata as any).villes),
    langues: Array.isArray(row.langues) ? row.langues : toStringArray((metadata as any).langues),
    Images: images,
    images,
    icon: row.icon || (metadata as any).icon || (images as any)?.logo || '',
    iconVIP: row.icon_vip || (metadata as any).iconVIP || '',
    translations: (metadata as any).translations || null,
    phone: (metadata as any).phone || null,
    whatsapp: (metadata as any).whatsapp || null,
    email: (metadata as any).email || null,
    website: (metadata as any).website || null,
    openingHours: (metadata as any).openingHours || null,
    discount: (metadata as any).discount || null,
    offersImages: toStringArray((metadata as any).offersImages),
  };
}

export async function getPartners(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { category, limit = 100 } = req.query;
    let query = supabase
      .from('partners')
      .select('*')
      .eq('is_active', true)
      .limit(Number(limit));

    if (category) {
      const value = String(category);
      query = query.or(`category.eq.${value},categorie.eq.${value}`);
    }

    const { data, error } = await query;
    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    const partners = (data || []).map((row) => toLegacyPartner(row as PartnerRow));

    res.json({ partners });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function getPartnerDetail(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { partnerId } = req.params;
    let { data, error } = await supabase
      .from('partners')
      .select('*')
      .eq('firestore_id', partnerId)
      .maybeSingle();

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    if (!data) {
      const fallback = await supabase
        .from('partners')
        .select('*')
        .eq('id', partnerId)
        .maybeSingle();
      data = fallback.data as any;
      error = fallback.error as any;
      if (error) {
        res.status(500).json({ error: error.message });
        return;
      }
    }

    if (!data) {
      res.status(404).json({ error: 'Partner not found' });
      return;
    }

    res.json(toLegacyPartner(data as PartnerRow));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function getVIPPartners(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { limit = 200 } = req.query;
    const { data, error } = await supabase
      .from('partners')
      .select('*')
      .eq('is_active', true)
      .or('is_vip.eq.true,vip.eq.true')
      .limit(Number(limit));

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    const partners = (data || []).map((row) => toLegacyPartner(row as PartnerRow));

    res.json({ partners });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

