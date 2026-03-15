import { Router } from 'express';
import * as paymeWebhookController from '../controllers/paymeWebhook.controller.js';

const router = Router();

// No auth: PayMe calls this URL directly after payment
router.post(
  '/subscription-webhook',
  async (req, res, next) => {
    try {
      await paymeWebhookController.handleSubscriptionWebhook(req, res);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
