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

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Firebase Admin
initializeFirebase();

// Middleware globaux
app.use(helmet());
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
  credentials: true
}));
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

// Error handling
app.use(notFoundHandler);
app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📝 Environment: ${process.env.NODE_ENV || 'development'}`);
});

export default app;

