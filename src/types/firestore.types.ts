// Types pour les collections Firestore principales

export type SeniorityTier = 'ultra_new' | 'new' | 'bronze' | 'silver' | 'gold' | 'platinum';

export interface ClientSeniority {
  version: 1;
  days: number;         // jours depuis "Created At"
  months: number;       // mois entiers
  tier: SeniorityTier;
  tierLabel: string;    // "Ultra-Nouveau" | "Nouveau" | "Bronze" | "Silver" | "Gold" | "Platinum"
  since: any;           // Timestamp — copie de "Created At"
  computedAt: any;      // Timestamp
}

export interface Client {
  uid: string;
  'First Name'?: string;
  'Last Name'?: string;
  Email?: string;
  'Phone Number'?: string | string[];
  language?: string;
  registrationComplete?: boolean;
  registrationCompletedAt?: any;
  createdVia?: string;
  createdAt?: any;
  'Created At'?: any;
  seniority?: ClientSeniority;
  activity?: {
    version: 1;
    score: number; // 0..100
    status: 'inactive' | 'low' | 'medium' | 'high' | 'very_high';
    lastRequestAt: any; // Date | Timestamp | null
    daysSinceLastRequest: number | null;
    currentMonthRequests: number;
    monthly_average: number;
    requests30d: number;
    requests90d: number;
    computedAt: any;
  };
  Membership?: string; // Legacy
  'Membership Plan'?: string; // Legacy
  'IsraCard Sub Code'?: string; // Legacy
  isUnpaid?: boolean; // Legacy
  membership?: {
    type: string;
    status: string;
    validUntil?: any;
  };
  fcmTokens?: string[];
  lastFcmToken?: string;
  fcmTokenUpdatedAt?: any;
  freeAccess?: {
    isEnabled: boolean;
    membership?: string;
    expiresAt?: any;
  };
}

export interface Request {
  requestId: string;
  'Request Type'?: string;
  'Request Category'?: string;
  'SubCategory ID'?: string;
  'Request Sub-Category'?: string;
  Description?: string;
  'Request Date'?: any;
  Priority?: string;
  'Uploaded Files'?: string[];
  'Available Days'?: string[];
  'Available Hours'?: string[];
  Tags?: string[];
  Status?: string; // Legacy (majuscule)
  status?: string; // Nouveau (minuscule)
  'Assigned to'?: string;
  'User ID'?: string;
  'First Name'?: string;
  'Last Name'?: string;
  Email?: string;
  'Category ID'?: string;
  'Form Data'?: any;
  'Created At'?: any;
  createdAt?: any; // Nouveau
  'Updated At'?: any;
  updatedAt?: any; // Nouveau
  rating?: number;
}

export interface Appointment {
  appointmentId: string;
  requestId?: string;
  slotId?: string;
  date?: any;
  time?: string;
  status?: string;
  notes?: string;
  createdAt?: any;
  updatedAt?: any;
}

export interface Document {
  documentId: string;
  type?: string;
  typeKey?: string;
  fileName?: string;
  fileUrl?: string;
  storagePath?: string;
  uploadedAt?: any;
  memberId?: string; // Si document d'un membre de la famille
}

export interface ChatMessage {
  messageId: string;
  conversationId?: string;
  threadId?: string;
  requestId?: string;
  senderId: string;
  senderName?: string;
  content: string;
  type?: 'text' | 'image' | 'file';
  attachments?: string[];
  createdAt: any;
  readAt?: any;
}

export interface Notification {
  notificationId: string;
  title: string;
  body: string;
  type?: string;
  data?: any;
  read: boolean;
  createdAt: any;
}

export interface Subscription {
  subscriptionId: string;
  type: string;
  status: string;
  validUntil?: any;
  planId?: string;
  createdAt?: any;
}

export interface Card {
  cardId: string;
  last4?: string;
  brand?: string;
  expiryMonth?: number;
  expiryYear?: number;
  isDefault?: boolean;
  createdAt?: any;
}

export interface Invoice {
  invoiceId: string;
  amount: number;
  currency?: string;
  status: string;
  dueDate?: any;
  paidAt?: any;
  createdAt: any;
}

export interface RefundRequest {
  refundId: string;
  requestId?: string;
  amount: number;
  reason?: string;
  status: string;
  createdAt: any;
  processedAt?: any;
}

export interface SupportTicket {
  ticketId: string;
  subject: string;
  description: string;
  status: string;
  priority?: string;
  createdAt: any;
  updatedAt?: any;
}

export interface HealthRequest {
  requestId: string;
  type?: string;
  description?: string;
  status?: string;
  createdAt: any;
}

export interface Partner {
  partnerId: string;
  name: string;
  description?: string;
  category?: string;
  isVIP?: boolean;
  logoUrl?: string;
  website?: string;
}

export interface Cinema {
  cinemaId: string;
  name: string;
  location?: string;
  movies?: any[];
}

