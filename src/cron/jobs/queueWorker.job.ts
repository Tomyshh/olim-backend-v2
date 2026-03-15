import { startQueueWorker } from '../../services/queue.service.js';
import { sendTwilioMessage } from '../../services/twilio.service.js';

export function registerQueueWorker(): boolean {
  const worker = startQueueWorker({
    queues: ['queue:v1:sms'],
    handlers: {
      'twilio:sms': async (job) => {
        await sendTwilioMessage(job.payload);
      },
    },
  });
  return worker.stop !== undefined;
}
