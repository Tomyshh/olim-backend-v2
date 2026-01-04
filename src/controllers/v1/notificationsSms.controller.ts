import { Response } from 'express';
import { AuthenticatedRequest } from '../../middleware/auth.middleware.js';
import { normalizeE164PhoneNumber } from '../../utils/phone.js';
import { sendTwilioMessage } from '../../services/twilio.service.js';
import { enqueueJob } from '../../services/queue.service.js';

export async function v1SendGenericSms(req: AuthenticatedRequest, res: Response): Promise<void> {
  const toNorm = normalizeE164PhoneNumber(req.body?.to);
  if (!toNorm.ok) {
    const err: any = new Error(toNorm.message);
    err.status = 400;
    throw err;
  }
  const body = typeof req.body?.body === 'string' ? req.body.body : '';
  if (!body.trim()) {
    const err: any = new Error('Message invalide.');
    err.status = 400;
    throw err;
  }

  // Optionnel: queue Redis pour lisser la charge / éviter les timeouts
  if (process.env.QUEUE_ENABLED === 'true') {
    const enq = await enqueueJob({
      queue: 'queue:v1:sms',
      type: 'twilio:sms',
      payload: {
        to: toNorm.e164,
        body,
        messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID?.trim() || undefined,
        from: process.env.TWILIO_SMS_FROM?.trim() || undefined
      }
    });
    if (enq) {
      res.status(202).json({ ok: true, queued: true, jobId: enq.jobId });
      return;
    }
    // Redis absent => fallback synchro
  }

  await sendTwilioMessage({
    to: toNorm.e164,
    body,
    messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID?.trim() || undefined,
    from: process.env.TWILIO_SMS_FROM?.trim() || undefined
  });

  res.json({ ok: true, queued: false });
}


