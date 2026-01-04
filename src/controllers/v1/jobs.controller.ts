import type { Response } from 'express';
import type { AuthenticatedRequest } from '../../middleware/auth.middleware.js';
import { getJob } from '../../services/queue.service.js';

export async function v1GetJobStatus(req: AuthenticatedRequest, res: Response): Promise<void> {
  const jobId = String((req.params as any)?.jobId || '').trim();
  if (!jobId) {
    res.status(400).json({ message: 'jobId manquant.' });
    return;
  }
  const job = await getJob(jobId);
  if (!job) {
    res.status(404).json({ message: 'Job introuvable.' });
    return;
  }
  // Pas de payload renvoyé (peut contenir PII). On renvoie seulement l’état.
  res.json({ jobId: job.id, status: job.status, type: job.type, updatedAt: job.updatedAt, createdAt: job.createdAt, error: job.error || null });
}


