import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import path from 'path';
import http from 'node:http';
import { initializeFirebase } from './config/firebase.js';
import { errorHandler } from './middleware/errorHandler.js';
import { notFoundHandler } from './middleware/notFoundHandler.js';
import { requestIdMiddleware } from './middleware/requestId.middleware.js';
import { responseTimeMiddleware } from './middleware/responseTime.middleware.js';
import { rateLimitMiddleware } from './middleware/rateLimit.middleware.js';
import { loadSheddingMiddleware, setOverloaded } from './middleware/loadShedding.middleware.js';

// Routes
import authRoutes from './routes/auth.routes.js';
import profileRoutes from './routes/profile.routes.js';
import requestsRoutes from './routes/requests.routes.js';
import appointmentsRoutes from './routes/appointments.routes.js';
import documentsRoutes from './routes/documents.routes.js';
import chatRoutes from './routes/chat.routes.js';
import notificationsRoutes from './routes/notifications.routes.js';
import subscriptionRoutes from './routes/subscription.routes.js';
import supportRoutes from './routes/support.routes.js';
import tipsRoutes from './routes/tips.routes.js';
import settingsRoutes from './routes/settings.routes.js';
import preferencesRoutes from './routes/preferences.routes.js';
import utilsRoutes from './routes/utils.routes.js';
import accountRoutes from './routes/account.routes.js';
import healthRoutes from './routes/health.routes.js';
import partnersRoutes from './routes/partners.routes.js';
import cinemaRoutes from './routes/cinema.routes.js';
import adminRoutes from './routes/admin.routes.js';
import qaRoutes from './routes/qa.routes.js';
import clientsRoutes from './routes/clients.routes.js';
import usersRoutes from './routes/users.routes.js';
import aiRoutes from './routes/ai.routes.js';
import promoRoutes from './routes/promo.routes.js';
import leadsRoutes from './routes/leads.routes.js';

// v1 routes (frontend)
import v1AuthPhoneOtpRoutes from './routes/v1/auth.phoneOtp.routes.js';
import v1MePhoneOtpRoutes from './routes/v1/me.phoneOtp.routes.js';
import v1NotificationsRoutes from './routes/v1/notifications.routes.js';
import v1MeMembershipRoutes from './routes/v1/me.membership.routes.js';
import v1FamilyMembersRoutes from './routes/v1/family.members.routes.js';
import v1AdminFamilyMembersRoutes from './routes/v1/admin.family.members.routes.js';
import v1AdminConseillersRoutes from './routes/v1/admin.conseillers.routes.js';
import v1AiAudioRoutes from './routes/v1/ai.audio.routes.js';
import v1JobsRoutes from './routes/v1/jobs.routes.js';
import v1RequestsRoutes from './routes/v1/requests.routes.js';
import v1RequestDraftsRoutes from './routes/v1/requestDrafts.routes.js';
import v1AnalyticsRoutes from './routes/v1/analytics.routes.js';
import v1UploadsRoutes from './routes/v1/uploads.routes.js';
import { startQueueWorker } from './services/queue.service.js';
import { sendTwilioMessage } from './services/twilio.service.js';
import { startDailyClientActivityScheduler } from './services/clientActivity.service.js';
import { startAnalyticsSyncScheduler } from './services/analyticsSync.service.js';
import { startPaymeMonthlyNextPaymentDateSyncScheduler } from './services/paymeMonthlyNextPaymentSync.service.js';
import { startDailySeniorityScheduler } from './services/clientSeniority.service.js';
import { startPromoRevertScheduler } from './services/promoRevert.service.js';
import { closeRedisClient } from './config/redis.js';

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Firebase Admin
initializeFirebase();

// Job quotidien (optionnel) : calcule l’activité des clients à 03:00
startDailyClientActivityScheduler();

// Job analytique : synchronise les données vers Supabase à 04:00
startAnalyticsSyncScheduler();

// Job PayMe (mensuel): synchronise nextPaymentDate/endDate (nuit)
startPaymeMonthlyNextPaymentDateSyncScheduler();

// Job ancienneté : met à jour le tier de seniority de chaque client à 01:00
startDailySeniorityScheduler();

// Job promo revert : remet le prix de base quand la durée d'une promo expire (05:00)
startPromoRevertScheduler();

// Middleware globaux
// Render (reverse proxy) : nécessaire pour que req.ip soit correct (rate-limit, logs)
app.set('trust proxy', 1);
app.use(helmet());

const DEFAULT_ALLOWED_ORIGINS = [
  'https://olimservice-7dbee.web.app',
  'https://olimservice-7dbee.firebaseapp.com',
  'http://localhost:3000',
  // CRM (prod) – IMPORTANT: permet au navigateur de lire les réponses d'erreur JSON
  // Si vous avez plusieurs domaines CRM, ajoutez-les via ALLOWED_ORIGINS (env) sur Render.
  'https://olimcrm.web.app',
  'https://olimcrm.firebaseapp.com'
];

function normalizeOrigin(value: string): string {
  // L'en-tête Origin ne contient jamais de chemin, mais on normalise quand même les "/" finaux
  return value.trim().replace(/\/+$/, '');
}

function getAllowedOrigins(): Set<string> {
  const envRaw = process.env.ALLOWED_ORIGINS || '';
  const envList = envRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(normalizeOrigin);

  return new Set([...DEFAULT_ALLOWED_ORIGINS.map(normalizeOrigin), ...envList]);
}

const allowedOrigins = getAllowedOrigins();

const corsOptions: NonNullable<Parameters<typeof cors>[0]> = {
  origin(
    origin: string | undefined,
    callback: (err: Error | null, allow?: boolean | string | string[]) => void
  ) {
    // Pas d'Origin => appels server-to-server / curl / health checks => OK
    if (!origin) return callback(null, true);

    const normalized = normalizeOrigin(origin);
    if (allowedOrigins.has(normalized)) return callback(null, true);

    return callback(new Error(`CORS: origin non autorisée: ${origin}`));
  },
  // Important pour Flutter Web (préflight avec Authorization)
  methods: ['GET', 'PUT', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type', 'Accept', 'Idempotency-Key'],
  // Permet au CRM de lire l'identifiant de requête pour corrélation avec Render
  exposedHeaders: ['X-Request-Id'],
  credentials: true,
  optionsSuccessStatus: 204
};

// CORS (inclut explicitement les pré-flights OPTIONS)
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(requestIdMiddleware);
app.use(responseTimeMiddleware);
app.use(loadSheddingMiddleware);

// Rate-limit global (feature-flag) — protège la prod lors de bursts
if (process.env.GLOBAL_RATE_LIMIT_ENABLED === 'true') {
  const limit = Number(process.env.GLOBAL_RATE_LIMIT_LIMIT || 300);
  const windowSeconds = Number(process.env.GLOBAL_RATE_LIMIT_WINDOW_SECONDS || 5 * 60);
  app.use(
    rateLimitMiddleware({
      prefix: 'rl:global:ip',
      limit: Number.isFinite(limit) && limit > 0 ? limit : 300,
      windowSeconds: Number.isFinite(windowSeconds) && windowSeconds > 0 ? windowSeconds : 5 * 60,
      preferUid: false,
      bypassOnError: true,
      message: 'Trop de requêtes.'
    })
  );
}

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(morgan('combined'));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// OpenAPI (Swagger)
app.get('/openapi.yaml', (req, res) => {
  res.setHeader('Content-Type', 'application/yaml; charset=utf-8');
  res.sendFile(path.join(process.cwd(), 'openapi.yaml'));
});

// Routes API
// IMPORTANT: Routes attendues par le frontend Flutter
app.use('/v1', v1AuthPhoneOtpRoutes);
app.use('/v1', v1MePhoneOtpRoutes);
app.use('/v1', v1NotificationsRoutes);
app.use('/v1', v1MeMembershipRoutes);
app.use('/v1', v1FamilyMembersRoutes);
app.use('/v1', v1AdminFamilyMembersRoutes);
app.use('/v1', v1AdminConseillersRoutes);
app.use('/v1', v1AiAudioRoutes);
app.use('/v1', v1JobsRoutes);
app.use('/v1', v1RequestsRoutes);
app.use('/v1', v1RequestDraftsRoutes);
app.use('/v1', v1AnalyticsRoutes);
app.use('/v1', v1UploadsRoutes);

app.use('/api/auth', authRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/requests', requestsRoutes);
app.use('/api/appointments', appointmentsRoutes);
app.use('/api/documents', documentsRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/subscription', subscriptionRoutes);
app.use('/api/promo', promoRoutes);
app.use('/api/support', supportRoutes);
app.use('/api', tipsRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/preferences', preferencesRoutes);
app.use('/api/utils', utilsRoutes);
// Alias v1 de compatibilité (même handlers) pour absorber les clients
// qui utilisent encore le préfixe /v1.
app.use('/v1/preferences', preferencesRoutes);
app.use('/v1/utils', utilsRoutes);
app.use('/api/account', accountRoutes);
app.use('/api/health', healthRoutes);
app.use('/api/partners', partnersRoutes);
app.use('/api/cinema', cinemaRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/qa', qaRoutes);
app.use('/api/clients', clientsRoutes);
app.use('/api/leads', leadsRoutes);
app.use('/api/ai', aiRoutes);

// Signup/init (frontend web)
// - Endpoint attendu : POST /users/init
// - Alias : POST /api/users/init (pratique selon reverse-proxy)
app.use('/users', usersRoutes);
app.use('/api/users', usersRoutes);

// Error handling
app.use(notFoundHandler);
app.use(errorHandler);

const server = http.createServer(app);

// Timeouts HTTP (évite connexions pendantes sous surcharge)
// Valeurs conservatrices, ajustables via env si besoin.
server.requestTimeout = Number(process.env.HTTP_REQUEST_TIMEOUT_MS || 60_000);
server.headersTimeout = Number(process.env.HTTP_HEADERS_TIMEOUT_MS || 65_000);
server.keepAliveTimeout = Number(process.env.HTTP_KEEPALIVE_TIMEOUT_MS || 5_000);

server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📝 Environment: ${process.env.NODE_ENV || 'development'}`);
});

// Worker queue (optionnel, activé via QUEUE_WORKER_ENABLED=true)
startQueueWorker({
  queues: ['queue:v1:sms'],
  handlers: {
    'twilio:sms': async (job) => {
      await sendTwilioMessage(job.payload);
    }
  }
});

// Event-loop lag (optionnel) => load shedding
if (process.env.LOAD_SHEDDING_ENABLED === 'true') {
  const intervalMs = Number(process.env.EVENT_LOOP_LAG_INTERVAL_MS || 500);
  const thresholdMs = Number(process.env.EVENT_LOOP_LAG_THRESHOLD_MS || 200);
  const iMs = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 500;
  const tMs = Number.isFinite(thresholdMs) && thresholdMs > 0 ? thresholdMs : 200;

  let last = Date.now();
  setInterval(() => {
    const now = Date.now();
    const lag = now - last - iMs;
    last = now;
    setOverloaded(lag > tMs);
  }, iMs).unref();
}

// Graceful shutdown (Render envoie SIGTERM)
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`🧹 Shutdown (${signal})...`);

  // Stop d’accepter de nouvelles connexions
  server.close(async () => {
    try {
      await closeRedisClient();
    } finally {
      process.exit(0);
    }
  });

  // Hard timeout
  const hardMs = Number(process.env.SHUTDOWN_HARD_TIMEOUT_MS || 10_000);
  setTimeout(() => process.exit(1), Number.isFinite(hardMs) && hardMs > 0 ? hardMs : 10_000).unref();
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

export default app;

