import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import path from 'path';
import { initializeFirebase } from './config/firebase.js';
import { errorHandler } from './middleware/errorHandler.js';
import { notFoundHandler } from './middleware/notFoundHandler.js';

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
import healthRoutes from './routes/health.routes.js';
import partnersRoutes from './routes/partners.routes.js';
import cinemaRoutes from './routes/cinema.routes.js';
import adminRoutes from './routes/admin.routes.js';
import qaRoutes from './routes/qa.routes.js';
import clientsRoutes from './routes/clients.routes.js';
import usersRoutes from './routes/users.routes.js';
import aiRoutes from './routes/ai.routes.js';

// v1 routes (frontend)
import v1AuthPhoneOtpRoutes from './routes/v1/auth.phoneOtp.routes.js';
import v1MePhoneOtpRoutes from './routes/v1/me.phoneOtp.routes.js';
import v1NotificationsRoutes from './routes/v1/notifications.routes.js';
import v1MeMembershipRoutes from './routes/v1/me.membership.routes.js';
import v1FamilyMembersRoutes from './routes/v1/family.members.routes.js';

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Firebase Admin
initializeFirebase();

// Middleware globaux
app.use(helmet());

const DEFAULT_ALLOWED_ORIGINS = [
  'https://olimservice-7dbee.web.app',
  'https://olimservice-7dbee.firebaseapp.com',
  'http://localhost:3000'
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
  credentials: true,
  optionsSuccessStatus: 204
};

// CORS (inclut explicitement les pré-flights OPTIONS)
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
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

app.use('/api/auth', authRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/requests', requestsRoutes);
app.use('/api/appointments', appointmentsRoutes);
app.use('/api/documents', documentsRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/subscription', subscriptionRoutes);
app.use('/api/support', supportRoutes);
app.use('/api/health', healthRoutes);
app.use('/api/partners', partnersRoutes);
app.use('/api/cinema', cinemaRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/qa', qaRoutes);
app.use('/api/clients', clientsRoutes);
app.use('/api/ai', aiRoutes);

// Signup/init (frontend web)
// - Endpoint attendu : POST /users/init
// - Alias : POST /api/users/init (pratique selon reverse-proxy)
app.use('/users', usersRoutes);
app.use('/api/users', usersRoutes);

// Error handling
app.use(notFoundHandler);
app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📝 Environment: ${process.env.NODE_ENV || 'development'}`);
});

export default app;

