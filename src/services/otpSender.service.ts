import { sendSmsViaGlobalSms } from './globalSms.service.js';
import { sendOtpViaTwilio } from './twilio.service.js';

export type OtpChannel = 'sms' | 'whatsapp';

export type OtpSmsProvider = 'twilio' | 'global_sms';

export function getOtpSmsProvider(): OtpSmsProvider {
  const raw = (process.env.OTP_SMS_PROVIDER || '').trim().toLowerCase();
  if (raw === 'global' || raw === 'globalsms' || raw === 'global_sms') return 'global_sms';
  return 'twilio';
}

function buildOtpBody(languageCode: string | undefined, code: string): string {
  const fr = `Votre code Olim Service est : ${code}`;
  const en = `Your Olim Service code is: ${code}`;
  const he = `קוד האימות של Olim Service הוא: ${code}`;

  const lang = (languageCode || 'fr').toLowerCase();
  if (lang.startsWith('he')) return he;
  if (lang.startsWith('en')) return en;
  return fr;
}

export async function sendOtp(params: {
  phoneNumberE164: string;
  languageCode?: string;
  channels: OtpChannel[];
  code: string;
}): Promise<void> {
  const provider = getOtpSmsProvider();

  if (provider === 'twilio') {
    return sendOtpViaTwilio(params);
  }

  // Global SMS: SMS uniquement
  if (!params.channels.includes('sms')) {
    const err: any = new Error('Aucun channel disponible.');
    err.status = 400;
    throw err;
  }

  // Si WhatsApp est demandé en plus, on ignore silencieusement (SMS suffit pour auth)
  const body = buildOtpBody(params.languageCode, params.code);
  await sendSmsViaGlobalSms({ toE164: params.phoneNumberE164, message: body });
}


