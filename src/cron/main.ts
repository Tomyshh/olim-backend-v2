import 'dotenv/config';
import http from 'node:http';
import { initializeFirebase } from '../config/firebase.js';
import { closeRedisClient } from '../config/redis.js';
import { registerAllJobs } from './jobs/index.js';

// ── Bootstrap ────────────────────────────────────────────────────────────────
initializeFirebase();

const registeredJobs = registerAllJobs();

if (registeredJobs.length === 0) {
  console.warn(
    '[cron] Aucun job activé. Vérifiez les variables d\'environnement *_ENABLED.'
  );
}

// ── Health-check HTTP (nécessaire pour Render Web Service) ───────────────────
const PORT = process.env.CRON_PORT || process.env.PORT || 10000;

const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        status: 'ok',
        service: 'olim-cron-worker',
        jobs: registeredJobs,
        uptime: Math.round(process.uptime()),
        timestamp: new Date().toISOString(),
      })
    );
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => {
  console.log(`🕒 Cron worker healthy on port ${PORT}`);
  console.log(`📋 Registered jobs: ${registeredJobs.join(', ') || 'none'}`);
});

// ── Graceful shutdown ────────────────────────────────────────────────────────
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`🧹 Cron worker shutdown (${signal})...`);

  server.close(async () => {
    try {
      await closeRedisClient();
    } finally {
      process.exit(0);
    }
  });

  const hardMs = Number(process.env.SHUTDOWN_HARD_TIMEOUT_MS || 10_000);
  setTimeout(
    () => process.exit(1),
    Number.isFinite(hardMs) && hardMs > 0 ? hardMs : 10_000
  ).unref();
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
