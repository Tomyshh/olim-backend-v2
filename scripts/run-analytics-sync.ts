import dotenv from 'dotenv';
import path from 'path';
import { initializeFirebase } from '../src/config/firebase.js';
import { syncAnalyticsToSupabase } from '../src/services/analyticsSync.service.js';

// Charger .env puis .env.local (si présent) pour les scripts manuels
dotenv.config();
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

async function main(): Promise<void> {
    console.log('[scripts/run-analytics-sync] Initializing Firebase...');
    initializeFirebase();

    console.log('[scripts/run-analytics-sync] Starting sync to Supabase...');
    try {
        await syncAnalyticsToSupabase();
        console.log('[scripts/run-analytics-sync] Done.');
        process.exit(0);
    } catch (err: any) {
        console.error('[scripts/run-analytics-sync] Failed:', err.message);
        process.exit(1);
    }
}

main();
