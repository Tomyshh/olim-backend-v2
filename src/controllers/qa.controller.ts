import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { getFirestore, admin } from '../config/firebase.js';
import { getRedisClientOptional } from '../config/redis.js';

type Period = 'all' | 'week' | 'month';

function parsePeriod(raw: unknown): Period {
  const p = String(raw ?? 'all').toLowerCase();
  if (p === 'all' || p === 'week' || p === 'month') return p;
  throw new Error('Invalid period');
}

function parseOptionalISODate(raw: unknown): Date | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const d = new Date(String(raw));
  if (Number.isNaN(d.getTime())) throw new Error('Invalid date');
  return d;
}

function computeRange(period: Period, start: Date | null, end: Date | null): { start: Date | null; end: Date | null } {
  if (start || end) return { start, end };
  if (period === 'all') return { start: null, end: null };

  const now = new Date();
  const days = period === 'week' ? 7 : 30;
  const s = new Date(now);
  s.setDate(now.getDate() - days);
  return { start: s, end: now };
}

function buildCacheKey(period: Period, start: Date | null, end: Date | null): string {
  const s = start ? start.toISOString() : 'null';
  const e = end ? end.toISOString() : 'null';
  return `qa:stats:v1:period=${period}:start=${s}:end=${e}`;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function toDate(value: any): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  // Firestore Timestamp
  if (typeof value === 'object' && typeof value.toDate === 'function') return value.toDate();
  // ISO string / number
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

export async function getQaStats(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const period = parsePeriod(req.query.period);
    const startRaw = parseOptionalISODate(req.query.start);
    const endRaw = parseOptionalISODate(req.query.end);
    const { start, end } = computeRange(period, startRaw, endRaw);

    if (start && end && start > end) {
      res.status(400).json({ error: '`start` must be <= `end`' });
      return;
    }

    const cacheKey = buildCacheKey(period, start, end);
    const ttlSeconds = Number(process.env.QA_REDIS_TTL_SECONDS || 90);
    const redis = await getRedisClientOptional();

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

    // Champs/collection configurables (pour coller à la réalité Firestore sans recoder)
    const collectionName = process.env.QA_COLLECTION_NAME || 'ChatCC';
    const scoreField = process.env.QA_SCORE_FIELD || 'satisfaction_score';
    const dateField = process.env.QA_DATE_FIELD || 'evaluation_date';
    const counselorField = process.env.QA_COUNSELOR_FIELD || 'counselorId';
    const dateType = (process.env.QA_DATE_TYPE || 'timestamp').toLowerCase(); // 'timestamp' | 'string'

    // Pagination pour éviter une requête gigantissime
    const pageSize = Number(process.env.QA_PAGE_SIZE || 1000);
    const hardLimit = Number(process.env.QA_HARD_DOC_LIMIT || 20000);

    let totalDocs = 0;
    let truncated = false;

    const perCounselor: Record<string, { count: number; sumScore: number; dist: Record<string, number> }> = {};
    const globalDist: Record<string, number> = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 };
    let globalSum = 0;
    let globalCount = 0;

    let minDate: Date | null = null;
    let maxDate: Date | null = null;

    let lastDoc: FirebaseFirestore.QueryDocumentSnapshot | null = null;

    while (true) {
      let q: FirebaseFirestore.Query = db.collection(collectionName);

      // Score > 0 (si le champ existe)
      q = q.where(scoreField, '>', 0);

      // Filtre date si fourni (on convertit en Timestamp pour matcher Firestore si dateField est un Timestamp)
      if (dateType === 'string') {
        if (start) q = q.where(dateField, '>=', start.toISOString());
        if (end) q = q.where(dateField, '<=', end.toISOString());
      } else {
        if (start) q = q.where(dateField, '>=', admin.firestore.Timestamp.fromDate(start));
        if (end) q = q.where(dateField, '<=', admin.firestore.Timestamp.fromDate(end));
      }

      // OrderBy requis avec range filters
      q = q.orderBy(dateField, 'asc');

      if (lastDoc) q = q.startAfter(lastDoc);
      q = q.limit(pageSize);

      const snap = await q.get();
      if (snap.empty) break;

      for (const doc of snap.docs) {
        totalDocs += 1;
        if (totalDocs > hardLimit) {
          truncated = true;
          break;
        }

        const data: any = doc.data();
        const counselorId = String(data?.[counselorField] ?? 'unknown');
        const scoreNum = Number(data?.[scoreField]);
        const scoreBucket = Number.isFinite(scoreNum) ? String(Math.max(1, Math.min(5, Math.round(scoreNum)))) : 'unknown';

        const d = toDate(data?.[dateField]);
        if (d) {
          if (!minDate || d.getTime() < minDate.getTime()) minDate = d;
          if (!maxDate || d.getTime() > maxDate.getTime()) maxDate = d;
        }

        if (!perCounselor[counselorId]) {
          perCounselor[counselorId] = { count: 0, sumScore: 0, dist: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 } };
        }

        perCounselor[counselorId].count += 1;
        if (Number.isFinite(scoreNum)) perCounselor[counselorId].sumScore += scoreNum;

        if (scoreBucket in perCounselor[counselorId].dist) {
          perCounselor[counselorId].dist[scoreBucket] += 1;
        }

        if (scoreBucket in globalDist) globalDist[scoreBucket] += 1;
        if (Number.isFinite(scoreNum)) {
          globalSum += scoreNum;
          globalCount += 1;
        }
      }

      if (truncated) break;
      lastDoc = snap.docs[snap.docs.length - 1]!;
      if (snap.size < pageSize) break;
    }

    const counselors = Object.entries(perCounselor)
      .map(([counselorId, v]) => ({
        counselorId,
        count: v.count,
        avgScore: v.count ? v.sumScore / v.count : null,
        dist: v.dist
      }))
      .sort((a, b) => (b.count - a.count) || String(a.counselorId).localeCompare(String(b.counselorId)));

    const payload = {
      period,
      range: {
        start: start ? start.toISOString() : null,
        end: end ? end.toISOString() : null
      },
      meta: {
        sourceCollection: collectionName,
        scoreField,
        dateField,
        counselorField,
        docsScanned: totalDocs,
        truncated,
        minDate: minDate ? minDate.toISOString() : null,
        maxDate: maxDate ? maxDate.toISOString() : null
      },
      global: {
        count: globalCount,
        avgScore: globalCount ? globalSum / globalCount : null,
        dist: globalDist
      },
      counselors
    };

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
    res.status(500).json({ error: error.message || 'Internal error' });
  }
}


