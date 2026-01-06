import { getFirestore, admin } from '../config/firebase.js';
import { supabase } from './supabase.service.js';
import { randomUUID } from 'node:crypto';
import { paymeGetSubscriptionStatus } from './payme.service.js';

/**
 * Service to sync analytical data from Firestore to Supabase.
 * Aimed at providing rich historical data for analysis.
 */

export async function syncAnalyticsToSupabase(): Promise<void> {
    const db = getFirestore();
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const startedAt = Date.now();

    console.log(`[analytics-sync] Starting sync for ${dateStr}...`);

    let clientsScanned = 0;
    let batchData: any[] = [];
    const pageSize = 200;
    let lastDoc: FirebaseFirestore.QueryDocumentSnapshot | null = null;

    // Aggregation variables
    let validClientsCount = 0;
    let activeClients30d = 0;
    let totalRequestsMonth = 0;
    let totalRequestsDay = 0;
    let requestsMonthList: number[] = [];
    let requestsDayList: number[] = [];

    const statusDistribution: Record<string, number> = {
        'inactive': 0,
        'low': 0,
        'medium': 0,
        'high': 0,
        'very_high': 0
    };

    const membershipDistribution: Record<string, number> = {
        'Visitor': 0,
        'Pack Start': 0,
        'Pack Essential': 0,
        'Pack VIP': 0,
        'Pack Elite': 0
    };

    let totalRequests30d = 0;

    const PAID_PACKS = new Set(['Pack Start', 'Pack Essential', 'Pack VIP', 'Pack Elite']);
    const paymeStatusCache = new Map<string, number | null>(); // key = String(subCode)
    let paymeChecks = 0;
    let paymeActive = 0;
    let paymeInactive = 0;
    let paymeNoSubCode = 0;
    let paymeErrors = 0;

    let annualChecks = 0;
    let annualActive = 0;
    let annualInactive = 0;
    let annualNoSubscriptionDoc = 0;
    let annualErrors = 0;

    // Debug: lister les clientIds comptés dans un pack précis (ex: "Pack Elite")
    const DEBUG_PACK = (process.env.ANALYTICS_DEBUG_PACK || '').trim();
    const debugPackClientIds: string[] = [];
    const LOG_EACH_CLIENT = process.env.ANALYTICS_LOG_EACH_CLIENT === 'true';
    const PROGRESS_ENABLED = process.env.ANALYTICS_PROGRESS === 'true';
    const PROGRESS_WITH_TOTAL = process.env.ANALYTICS_PROGRESS_WITH_TOTAL === 'true';
    const progressEvery = Math.max(1, Number(process.env.ANALYTICS_PROGRESS_EVERY || 200));
    const progressIntervalMs = Math.max(250, Number(process.env.ANALYTICS_PROGRESS_INTERVAL_MS || 5000));
    let lastProgressLogAt = 0;
    let totalClientsEstimate: number | null = null;

    const subscriptionCurrentCache = new Map<string, Record<string, any> | null>();

    async function loadSubscriptionCurrent(clientId: string): Promise<Record<string, any> | null> {
        if (subscriptionCurrentCache.has(clientId)) return subscriptionCurrentCache.get(clientId)!;
        try {
            const snap = await db.collection('Clients').doc(clientId).collection('subscription').doc('current').get();
            const value = snap.exists ? ((snap.data() || {}) as Record<string, any>) : null;
            subscriptionCurrentCache.set(clientId, value);
            return value;
        } catch {
            subscriptionCurrentCache.set(clientId, null);
            return null;
        }
    }

    function pickString(value: unknown): string {
        return typeof value === 'string' ? value.trim() : '';
    }

    function extractMembershipFromSubscriptionCurrent(s: Record<string, any> | null): string {
        if (!s) return '';
        // Support plusieurs schémas:
        // - { plan: { membership: "Pack Elite" } }
        // - { membership: "Pack Elite" }
        // - legacy éventuel
        return (
            pickString(s?.plan?.membership) ||
            pickString(s?.plan?.Membership) ||
            pickString(s?.membership) ||
            ''
        );
    }

    function extractSubCodeFromSubscriptionCurrent(s: Record<string, any> | null): number | null {
        if (!s) return null;
        const candidates = [
            s?.subCode,
            s?.sub_payme_code,
            s?.payme?.subCode,
            s?.payme?.sub_payme_code
        ];
        for (const c of candidates) {
            const n = coerceSubCode(c);
            if (n != null) return n;
        }
        return null;
    }

    function coerceSubCode(value: unknown): number | null {
        if (typeof value === 'number' && Number.isFinite(value)) return value;
        if (typeof value === 'string' && value.trim()) {
            const trimmed = value.trim();
            const n = Number(trimmed);
            return Number.isFinite(n) ? n : null;
        }
        return null;
    }

    function isFirestoreTimestampLike(value: any): value is { toDate: () => Date } {
        return !!value && typeof value === 'object' && typeof value.toDate === 'function';
    }

    function parseDateLike(value: any): Date | null {
        if (!value) return null;
        if (value instanceof Date) return value;
        if (isFirestoreTimestampLike(value)) return value.toDate();
        // Firestore Timestamp JSON-like {seconds,nanoseconds} ou {_seconds,_nanoseconds}
        if (typeof value === 'object') {
            const seconds = (value as any).seconds ?? (value as any)._seconds;
            if (typeof seconds === 'number' && Number.isFinite(seconds)) {
                return new Date(seconds * 1000);
            }
        }
        return null;
    }

    function extractPaymeSubCodeFromClientDoc(data: Record<string, any>): number | null {
        // Legacy + nouveau schéma (on tente plusieurs clés)
        const candidates = [
            data.israCard_subCode,
            data['IsraCard Sub Code'],
            data['IsraCard Sub code'],
            data['IsraCard SubCode'],
            data.subCode,
            data.paymeSubCode
        ];
        for (const c of candidates) {
            const subCode = coerceSubCode(c);
            if (subCode != null) return subCode;
        }
        return null;
    }

    function renderProgressBar(ratio: number, width: number = 20): string {
        const r = Math.max(0, Math.min(1, ratio));
        const filled = Math.round(r * width);
        return `[${'='.repeat(filled)}${' '.repeat(Math.max(0, width - filled))}] ${(r * 100).toFixed(1)}%`;
    }

    function formatDurationMs(ms: number): string {
        const s = Math.max(0, Math.round(ms / 1000));
        const m = Math.floor(s / 60);
        const sec = s % 60;
        if (m < 60) return `${m}m${String(sec).padStart(2, '0')}s`;
        const h = Math.floor(m / 60);
        const mm = m % 60;
        return `${h}h${String(mm).padStart(2, '0')}m`;
    }

    function maybeLogProgress(force: boolean = false): void {
        if (!PROGRESS_ENABLED) return;
        const nowMs = Date.now();
        const elapsedMs = nowMs - startedAt;
        const shouldByCount = clientsScanned > 0 && clientsScanned % progressEvery === 0;
        const shouldByTime = nowMs - lastProgressLogAt >= progressIntervalMs;
        if (!force && !shouldByCount && !shouldByTime) return;
        lastProgressLogAt = nowMs;

        const rate = elapsedMs > 0 ? clientsScanned / (elapsedMs / 1000) : 0;
        const etaMs =
            totalClientsEstimate && rate > 0 ? ((totalClientsEstimate - clientsScanned) / rate) * 1000 : null;

        const bar = totalClientsEstimate ? renderProgressBar(clientsScanned / totalClientsEstimate) : null;
        console.log('[analytics-sync] Progress', {
            scanned: clientsScanned,
            total: totalClientsEstimate,
            ...(bar ? { bar } : {}),
            validClients: validClientsCount,
            elapsed: formatDurationMs(elapsedMs),
            rateClientsPerSec: Number(rate.toFixed(2)),
            ...(etaMs != null ? { eta: formatDurationMs(etaMs) } : {}),
            paymeChecks,
            paymeErrors,
            annualChecks
        });
    }

    async function isClientMonthlyPaymeActive(params: { clientId: string; clientData: Record<string, any> }): Promise<boolean> {
        // Source of truth: subscription/current.subCode (si présent), sinon doc client principal
        const s = await loadSubscriptionCurrent(params.clientId);
        const subCode = extractSubCodeFromSubscriptionCurrent(s) ?? extractPaymeSubCodeFromClientDoc(params.clientData);
        if (subCode == null) {
            paymeNoSubCode++;
            return false;
        }

        const cacheKey = String(subCode);
        if (paymeStatusCache.has(cacheKey)) {
            const cached = paymeStatusCache.get(cacheKey);
            return cached === 2;
        }

        paymeChecks++;
        try {
            const status = await paymeGetSubscriptionStatus(subCode);
            paymeStatusCache.set(cacheKey, status);
            if (status === 2) {
                paymeActive++;
                return true;
            }
            paymeInactive++;
            return false;
        } catch (e: any) {
            paymeErrors++;
            console.warn('[analytics-sync] PayMe get-subscriptions failed (non bloquant)', {
                clientId: params.clientId,
                subCode,
                error: e?.message || String(e)
            });
            // Sécurité: ne pas compter comme actif si on n'arrive pas à vérifier
            return false;
        }
    }

    async function isClientAnnualActive(params: { clientId: string; clientData: Record<string, any> }): Promise<boolean> {
        annualChecks++;

        // Legacy flag: unpaid => pas actif
        if (params.clientData?.isUnpaid === true) {
            annualInactive++;
            return false;
        }

        try {
            const data = (await loadSubscriptionCurrent(params.clientId)) || null;
            if (!data) {
                annualNoSubscriptionDoc++;
                // Fallback: nouveau champ membership (si présent) avec validUntil
                const validUntil = parseDateLike(params.clientData?.membership?.validUntil);
                const status = typeof params.clientData?.membership?.status === 'string' ? params.clientData.membership.status : '';
                if (validUntil && validUntil.getTime() > now.getTime() && status !== 'cancelled' && status !== 'unpaid') {
                    annualActive++;
                    return true;
                }
                annualInactive++;
                return false;
            }

            // Support schémas: states.isActive OU status="active"
            const statusStr = pickString(data?.status).toLowerCase();
            const isActive = data?.states?.isActive !== false && (statusStr ? statusStr === 'active' : true);
            const cancelledDate = parseDateLike(data?.dates?.cancelledDate);
            const endDate = parseDateLike(data?.dates?.endDate);

            // "Annuel actif" = actif + non annulé + endDate dans le futur
            const ok = Boolean(isActive) && !cancelledDate && !!endDate && endDate.getTime() > now.getTime();
            if (ok) annualActive++;
            else annualInactive++;
            return ok;
        } catch (e: any) {
            annualErrors++;
            console.warn('[analytics-sync] Annual subscription check failed (non bloquant)', {
                clientId: params.clientId,
                error: e?.message || String(e)
            });
            return false;
        }
    }

    async function inferPaidPlanTypeFromSubscriptionCurrent(clientId: string): Promise<'monthly' | 'annual' | null> {
        try {
            const s = await loadSubscriptionCurrent(clientId);
            if (!s) return null;

            // Si PayMe subCode existe => mensuel (subscription PayMe)
            const coerced = extractSubCodeFromSubscriptionCurrent(s);
            if (coerced != null) return 'monthly';

            const planType = typeof s?.plan?.type === 'string' ? String(s.plan.type).toLowerCase().trim() : '';
            if (planType === 'monthly') return 'monthly';
            if (planType === 'annual') return 'annual';

            // Fallback: si endDate existe et est éloigné (~>=300j) on suppose annuel
            const endDate = parseDateLike(s?.dates?.endDate);
            const startDate = parseDateLike(s?.dates?.startDate);
            if (endDate && startDate) {
                const days = Math.round((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));
                if (days >= 300) return 'annual';
                if (days >= 20 && days <= 40) return 'monthly';
            }

            return null;
        } catch {
            return null;
        }
    }

    try {
        if (PROGRESS_ENABLED && PROGRESS_WITH_TOTAL) {
            try {
                // Firestore aggregate count (si supporté)
                const agg = await (db.collection('Clients') as any).count().get();
                const v = agg?.data?.()?.count;
                const n = typeof v === 'number' ? v : Number(v);
                totalClientsEstimate = Number.isFinite(n) ? n : null;
            } catch {
                totalClientsEstimate = null;
            }
        }
        maybeLogProgress(true);

        while (true) {
            let q = db.collection('Clients').orderBy(admin.firestore.FieldPath.documentId()).limit(pageSize);
            if (lastDoc) q = q.startAfter(lastDoc);

            const snap = await q.get();
            if (snap.empty) break;
            lastDoc = snap.docs[snap.docs.length - 1]!;

            for (const clientDoc of snap.docs) {
                clientsScanned++;
                const data = clientDoc.data();
                const activity = data.activity;
                if (LOG_EACH_CLIENT) {
                    console.log('[analytics-sync] Client', { clientId: clientDoc.id });
                }
                maybeLogProgress(false);

                // On ne traite que les clients qui ont déjà fait au moins une demande
                if (activity && activity.lastRequestAt) {
                    const status = activity.status || 'inactive';
                    const r30 = Number(activity.requests30d || 0);
                    const rMonth = Number(activity.currentMonthRequests || 0);
                    const rDay = Number(activity.monthly_average || 0);

                    // Prepare granular history record
                    batchData.push({
                        client_id: clientDoc.id,
                        email: data.Email || null,
                        score: Number(activity.score || 0),
                        status: status,
                        requests_30d: r30,
                        requests_90d: Number(activity.requests90d || 0),
                        monthly_average: rDay,
                        last_request_at: new Date(activity.lastRequestAt._seconds * 1000).toISOString(),
                        computed_at: now.toISOString()
                    });

                    // Metrics for platform stats
                    validClientsCount++;
                    totalRequestsMonth += rMonth;
                    totalRequestsDay += rDay;
                    requestsMonthList.push(rMonth);
                    requestsDayList.push(rDay);

                    if (r30 > 0) {
                        activeClients30d++;
                    }

                    if (statusDistribution[status] !== undefined) {
                        statusDistribution[status]++;
                    }

                    // Membership distribution (from main client document)
                    // Source of truth: subscription/current.plan.membership si présent, sinon doc client principal
                    const subCurrent = await loadSubscriptionCurrent(clientDoc.id);
                    const membershipFromSub = extractMembershipFromSubscriptionCurrent(subCurrent);
                    const membership = membershipFromSub || data.Membership || 'Visitor';
                    const membershipNormalized = typeof membership === 'string' ? membership.trim() : 'Visitor';
                    const subPlan = typeof data.subPlan === 'number' ? data.subPlan : Number(data.subPlan || 0);

                    if (PAID_PACKS.has(membershipNormalized)) {
                        // Important: ne jamais compter un pack payant sans vérifier qu'il est actif.
                        let paidOk = false;
                        if (subPlan === 3) {
                            paidOk = await isClientMonthlyPaymeActive({ clientId: clientDoc.id, clientData: data });
                        } else if (subPlan === 4) {
                            paidOk = await isClientAnnualActive({ clientId: clientDoc.id, clientData: data });
                        } else {
                            // subPlan manquant/incorrect: inférer via subscription/current
                            const inferred = await inferPaidPlanTypeFromSubscriptionCurrent(clientDoc.id);
                            if (inferred === 'monthly') {
                                paidOk = await isClientMonthlyPaymeActive({ clientId: clientDoc.id, clientData: data });
                            } else if (inferred === 'annual') {
                                paidOk = await isClientAnnualActive({ clientId: clientDoc.id, clientData: data });
                            } else {
                                paidOk = false;
                            }
                        }

                        if (paidOk) {
                            membershipDistribution[membershipNormalized] = (membershipDistribution[membershipNormalized] || 0) + 1;
                            if (DEBUG_PACK && membershipNormalized === DEBUG_PACK) {
                                debugPackClientIds.push(clientDoc.id);
                            }
                        }
                    } else if (membershipDistribution[membershipNormalized] !== undefined) {
                        // Visitor (ou autres clés prévues)
                        membershipDistribution[membershipNormalized]++;
                    } else {
                        // Support legacy or unexpected types
                        membershipDistribution[membershipNormalized] = (membershipDistribution[membershipNormalized] || 0) + 1;
                    }

                    totalRequests30d += r30;
                }

                // Periodic insert to Supabase to avoid huge memory usage
                if (batchData.length >= 100) {
                    const { error } = await supabase.from('client_activity_history').upsert(batchData, {
                        onConflict: 'client_id,computed_at',
                        ignoreDuplicates: false
                    });
                    if (error) console.error(`[analytics-sync] Supabase upsert error: ${error.message}`);
                    batchData = [];
                }
            }
        }

        // Final batch insert
        if (batchData.length > 0) {
            const { error } = await supabase.from('client_activity_history').upsert(batchData);
            if (error) console.error(`[analytics-sync] Final Supabase upsert error: ${error.message}`);
        }

        // Helper functions for stats
        const calculateMedian = (arr: number[]) => {
            if (arr.length === 0) return 0;
            const sorted = [...arr].sort((a, b) => a - b);
            const mid = Math.floor(sorted.length / 2);
            return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
        };

        // Insert platform aggregate stats
        const { error: statsError } = await supabase.from('daily_platform_stats').upsert({
            date: dateStr,
            total_clients: validClientsCount,
            active_clients_30d: activeClients30d,
            avg_request_month: validClientsCount > 0 ? Number((totalRequestsMonth / validClientsCount).toFixed(2)) : 0,
            avg_request_day: validClientsCount > 0 ? Number((totalRequestsDay / validClientsCount).toFixed(2)) : 0,
            median_request_month: calculateMedian(requestsMonthList),
            median_request_day: Number(calculateMedian(requestsDayList).toFixed(2)),
            status_distribution: statusDistribution,
            membership_distribution: membershipDistribution,
            total_requests_30d: totalRequests30d
        });

        if (statsError) console.error(`[analytics-sync] Supabase stats error: ${statsError.message}`);

        maybeLogProgress(true);

        console.log('[analytics-sync] PayMe checks summary', {
            paymeChecks,
            paymeActive,
            paymeInactive,
            paymeNoSubCode,
            paymeErrors
        });

        console.log('[analytics-sync] Annual checks summary', {
            annualChecks,
            annualActive,
            annualInactive,
            annualNoSubscriptionDoc,
            annualErrors
        });

        if (DEBUG_PACK) {
            console.log(`[analytics-sync] DEBUG_PACK=${DEBUG_PACK} counted clientIds`, {
                count: debugPackClientIds.length,
                clientIds: debugPackClientIds
            });
        }

        console.log(`[analytics-sync] Sync completed. Scanned ${clientsScanned} clients, synced ${validClientsCount} valid clients.`);
    } catch (error: any) {
        console.error(`[analytics-sync] Sync failed: ${error.message}`);
        throw error;
    }
}

/**
 * Scheduler logic
 */
function msUntilNextLocalTime(params: { hour: number; minute: number; second?: number }): number {
    const now = new Date();
    const second = params.second ?? 0;
    const next = new Date(now);
    next.setHours(params.hour, params.minute, second, 0);
    if (next.getTime() <= now.getTime()) {
        next.setDate(next.getDate() + 1);
    }
    return Math.max(0, next.getTime() - now.getTime());
}

export function startAnalyticsSyncScheduler(): void {
    // Use 4 AM as requested by the user
    const hour = 4;
    const minute = 0;

    async function runAndReschedule(): Promise<void> {
        try {
            await syncAnalyticsToSupabase();
        } catch (e: any) {
            console.warn('[analytics-sync] Job failed', { error: e.message });
        } finally {
            const ms = msUntilNextLocalTime({ hour, minute, second: 0 });
            console.log('[analytics-sync] Next run scheduled in', Math.round(ms / 1000 / 60), 'minutes');
            setTimeout(() => void runAndReschedule(), ms).unref();
        }
    }

    const firstDelay = msUntilNextLocalTime({ hour, minute, second: 0 });
    console.log('[analytics-sync] Scheduler enabled for 4:00 AM. First delay:', Math.round(firstDelay / 1000 / 60), 'minutes');
    setTimeout(() => void runAndReschedule(), firstDelay).unref();
}
