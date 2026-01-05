import { getFirestore, admin } from '../config/firebase.js';
import { supabase } from './supabase.service.js';
import { randomUUID } from 'node:crypto';

/**
 * Service to sync analytical data from Firestore to Supabase.
 * Aimed at providing rich historical data for analysis.
 */

export async function syncAnalyticsToSupabase(): Promise<void> {
    const db = getFirestore();
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];

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

    try {
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
                    const membership = data.Membership || 'Visitor';
                    if (membershipDistribution[membership] !== undefined) {
                        membershipDistribution[membership]++;
                    } else {
                        // Support legacy or unexpected types
                        membershipDistribution[membership] = (membershipDistribution[membership] || 0) + 1;
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
