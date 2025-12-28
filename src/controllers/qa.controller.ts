import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { getFirestore, admin } from '../config/firebase.js';
import { getRedisClientOptional } from '../config/redis.js';

type Period = 'all' | 'week' | 'month' | 'custom';

interface ChatData {
  id: string;
  satisfaction_score: number;
  counselorId: string;
  counselorName?: string;
  evaluation_date?: FirebaseFirestore.Timestamp | Date | string;
  evaluation_feedback?: string;
  evaluation_strengths?: string;
  evaluation_improvements?: string;
}

interface ChatMessage {
  content: string;
  senderId: string;
  senderName: string;
  timestamp: FirebaseFirestore.Timestamp | Date | string | null;
  type: string;
}

interface ChatEvaluation {
  chatId: string;
  score: number;
  feedback: string;
  strengths: string;
  improvements: string;
  evaluationDate: string | null;
  messages: Array<{
    content: string;
    senderId: string;
    senderName: string;
    timestamp: string | null;
    type: string;
  }>;
}

interface CounselorStats {
  counselorId: string;
  counselorName: string;
  totalChats: number;
  averageScore: number;
  excellentCount: number;
  goodCount: number;
  averageCount: number;
  poorCount: number;
  commonImprovements: string[];
  commonStrengths: string[];
  lastEvaluationDate: string | null;
  chatEvaluations: ChatEvaluation[];
}

function parsePeriod(raw: unknown): Period {
  const p = String(raw ?? 'all').toLowerCase();
  if (p === 'all' || p === 'week' || p === 'month' || p === 'custom') return p;
  throw new Error('Invalid period. Must be: all, week, month, or custom');
}

function parseOptionalISODate(raw: unknown): Date | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const d = new Date(String(raw));
  if (Number.isNaN(d.getTime())) throw new Error('Invalid date format. Expected ISO8601');
  return d;
}

function buildCacheKey(period: Period, start: string | null, end: string | null): string {
  if (period === 'custom' && start && end) {
    return `olimcrm:qa:stats:v1:period=custom:start=${start}:end=${end}`;
  }
  return `olimcrm:qa:stats:v1:period=${period}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toDate(value: any): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  // Firestore Timestamp
  if (typeof value === 'object' && typeof value.toDate === 'function') {
    return value.toDate();
  }
  // ISO string / number
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function toISOString(value: any): string | null {
  const date = toDate(value);
  return date ? date.toISOString() : null;
}

/**
 * Récupère les messages d'un chat depuis la sous-collection ChatCC/{chatId}/messages
 */
async function getChatMessages(
  db: FirebaseFirestore.Firestore,
  chatId: string
): Promise<ChatMessage[]> {
  try {
    const messagesSnapshot = await db
      .collection('ChatCC')
      .doc(chatId)
      .collection('messages')
      .orderBy('timestamp', 'asc')
      .get();

    return messagesSnapshot.docs.map((msgDoc) => {
      const msgData = msgDoc.data();
      return {
        content: msgData.content || '',
        senderId: msgData.senderId || '',
        senderName: msgData.senderName || '',
        timestamp: msgData.timestamp || null,
        type: msgData.type || 'text'
      };
    });
  } catch (error) {
    console.error(`Erreur lors de la récupération des messages pour chat ${chatId}:`, error);
    return [];
  }
}

/**
 * Catégorise un score de satisfaction
 */
function categorizeScore(score: number): 'excellent' | 'good' | 'average' | 'poor' {
  if (score >= 90) return 'excellent';
  if (score >= 80) return 'good';
  if (score >= 70) return 'average';
  return 'poor';
}

/**
 * Calcule les statistiques pour un conseiller
 */
async function calculateCounselorStats(
  db: FirebaseFirestore.Firestore,
  counselorId: string,
  chats: ChatData[]
): Promise<CounselorStats> {
  let totalScore = 0;
  let excellent = 0;
  let good = 0;
  let average = 0;
  let poor = 0;
  const improvements: string[] = [];
  const strengths: string[] = [];
  let lastEvalDate: Date | null = null;
  const chatEvaluations: ChatEvaluation[] = [];

  // Récupérer le nom du conseiller (depuis le premier chat)
  const counselorName = chats[0]?.counselorName || 'Inconnu';

  // Parcourir chaque chat du conseiller
  for (const chat of chats) {
    const score = chat.satisfaction_score || 0;
    totalScore += score;

    // Catégoriser le score
    const category = categorizeScore(score);
    if (category === 'excellent') excellent++;
    else if (category === 'good') good++;
    else if (category === 'average') average++;
    else poor++;

    // Collecter feedbacks
    if (chat.evaluation_improvements) {
      improvements.push(chat.evaluation_improvements);
    }
    if (chat.evaluation_strengths) {
      strengths.push(chat.evaluation_strengths);
    }

    // Date d'évaluation
    const evalDate = toDate(chat.evaluation_date);
    if (evalDate) {
      if (!lastEvalDate || evalDate > lastEvalDate) {
        lastEvalDate = evalDate;
      }
    }

    // Récupérer les messages du chat
    const messages = await getChatMessages(db, chat.id);

    // Convertir les messages pour le format de réponse
    const formattedMessages = messages.map((msg) => ({
      content: msg.content,
      senderId: msg.senderId,
      senderName: msg.senderName,
      timestamp: toISOString(msg.timestamp),
      type: msg.type
    }));

    chatEvaluations.push({
      chatId: chat.id,
      score: score,
      feedback: chat.evaluation_feedback || '',
      strengths: chat.evaluation_strengths || '',
      improvements: chat.evaluation_improvements || '',
      evaluationDate: toISOString(chat.evaluation_date),
      messages: formattedMessages
    });
  }

  const averageScore = chats.length > 0 ? totalScore / chats.length : 0;

  return {
    counselorId: counselorId,
    counselorName: counselorName,
    totalChats: chats.length,
    averageScore: Math.round(averageScore * 100) / 100, // 2 décimales
    excellentCount: excellent,
    goodCount: good,
    averageCount: average,
    poorCount: poor,
    commonImprovements: improvements.slice(0, 5), // Top 5
    commonStrengths: strengths.slice(0, 5), // Top 5
    lastEvaluationDate: lastEvalDate ? lastEvalDate.toISOString() : null,
    chatEvaluations: chatEvaluations
  };
}

export async function getQaStats(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const period = parsePeriod(req.query.period);
    const startRaw = parseOptionalISODate(req.query.start);
    const endRaw = parseOptionalISODate(req.query.end);

    // Validation pour custom period
    if (period === 'custom') {
      if (!startRaw || !endRaw) {
        res.status(400).json({
          error: 'Les paramètres start et end sont requis pour period=custom (format ISO8601)'
        });
        return;
      }
      if (startRaw >= endRaw) {
        res.status(400).json({ error: 'start doit être strictement inférieur à end' });
        return;
      }
    }

    // Construire les dates de filtrage
    let startDate: Date | null = null;
    let endDate: Date | null = null;

    if (period === 'week') {
      const weekAgo = new Date();
      weekAgo.setDate(weekAgo.getDate() - 7);
      startDate = weekAgo;
    } else if (period === 'month') {
      const monthAgo = new Date();
      monthAgo.setDate(monthAgo.getDate() - 30);
      startDate = monthAgo;
    } else if (period === 'custom' && startRaw && endRaw) {
      startDate = startRaw;
      endDate = endRaw;
    }

    // Construire la clé de cache
    const startISO = startDate ? startDate.toISOString() : null;
    const endISO = endDate ? endDate.toISOString() : null;
    const cacheKey = buildCacheKey(period, startISO, endISO);
    const ttlSeconds = Number(process.env.QA_REDIS_TTL_SECONDS || 90);
    const redis = await getRedisClientOptional();

    // Vérifier le cache Redis
    if (redis) {
      const cached = await redis.get(cacheKey);
      if (cached) {
        res.setHeader('X-Cache', 'HIT');
        res.json(JSON.parse(cached));
        return;
      }
    }

    // Anti-stampede: lock court
    const lockKey = `lock:${cacheKey}`;
    const lockToken = `${Date.now()}:${Math.random().toString(16).slice(2)}`;
    const lockTtlSeconds = Number(process.env.QA_REDIS_LOCK_TTL_SECONDS || 15);

    let haveLock = false;
    if (redis) {
      const lockRes = await redis.set(lockKey, lockToken, { NX: true, EX: lockTtlSeconds });
      haveLock = lockRes === 'OK';

      if (!haveLock) {
        // Attendre un court instant que le worker qui a le lock remplisse le cache
        for (const waitMs of [200, 300, 500]) {
          await sleep(waitMs);
          const cached = await redis.get(cacheKey);
          if (cached) {
            res.setHeader('X-Cache', 'WAIT_HIT');
            res.json(JSON.parse(cached));
            return;
          }
        }
      }
    }

    const db = getFirestore();

    // Étape 1: Requête Firestore avec filtres
    let query: FirebaseFirestore.Query = db
      .collection('ChatCC')
      .where('satisfaction_score', '>', 0);

    // Appliquer filtre période
    if (startDate) {
      query = query.where(
        'evaluation_date',
        '>=',
        admin.firestore.Timestamp.fromDate(startDate)
      );
    }
    if (endDate) {
      query = query.where(
        'evaluation_date',
        '<',
        admin.firestore.Timestamp.fromDate(endDate)
      );
    }

    // OrderBy requis avec range filters
    if (startDate || endDate) {
      query = query.orderBy('evaluation_date', 'asc');
    }

    const chatsSnapshot = await query.get();

    // Étape 2: Regrouper par counselorId
    const counselorChats: Record<string, ChatData[]> = {};

    chatsSnapshot.docs.forEach((doc) => {
      const data = doc.data();
      const counselorId = data.counselorId;

      if (!counselorId) return; // Ignorer si pas de counselorId

      if (!counselorChats[counselorId]) {
        counselorChats[counselorId] = [];
      }

      counselorChats[counselorId].push({
        id: doc.id,
        satisfaction_score: data.satisfaction_score || 0,
        counselorId: data.counselorId,
        counselorName: data.counselorName,
        evaluation_date: data.evaluation_date,
        evaluation_feedback: data.evaluation_feedback,
        evaluation_strengths: data.evaluation_strengths,
        evaluation_improvements: data.evaluation_improvements
      });
    });

    // Étape 3: Pour chaque conseiller, calculer les stats
    const stats: CounselorStats[] = [];

    for (const [counselorId, chats] of Object.entries(counselorChats)) {
      const counselorStats = await calculateCounselorStats(db, counselorId, chats);
      stats.push(counselorStats);
    }

    // Trier par nombre de chats décroissant
    stats.sort((a, b) => b.totalChats - a.totalChats);

    const payload = {
      counselors: stats
    };

    // Mettre en cache Redis (TTL 60-120s)
    if (redis && ttlSeconds > 0 && haveLock) {
      await redis.set(cacheKey, JSON.stringify(payload), { EX: ttlSeconds });
    }

    // Release lock (best-effort) uniquement si on est propriétaire
    if (redis && haveLock) {
      try {
        const current = await redis.get(lockKey);
        if (current === lockToken) await redis.del(lockKey);
      } catch {
        // ignore
      }
    }

    res.setHeader('X-Cache', redis ? (haveLock ? 'MISS' : 'MISS_NOLOCK') : 'BYPASS');
    res.json(payload);
  } catch (error: any) {
    console.error('Erreur /qa/stats:', error);
    res.status(500).json({ error: error.message || 'Internal error' });
  }
}


