import { Router } from 'express';
import * as supportController from '../controllers/support.controller.js';
import { authenticateToken, optionalAuth } from '../middleware/auth.middleware.js';

const router = Router();

// FAQs (public)
router.get('/faqs', supportController.getFAQs);

// Contacts support (public)
router.get('/contacts', supportController.getSupportContacts);

// Messages contact (peut être sans auth)
router.post('/contact-messages', optionalAuth, supportController.sendContactMessage);

// Routes nécessitant authentification
router.use(authenticateToken);

// Tickets support
router.get('/tickets', supportController.getSupportTickets);
router.post('/tickets', supportController.createSupportTicket);
router.get('/tickets/:ticketId', supportController.getSupportTicketDetail);
router.patch('/tickets/:ticketId', supportController.updateSupportTicket);

export default router;

