function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v?.trim()) throw new Error(`${name} is not set`);
  return v.trim();
}

function maskPhoneForLogs(input: string): string {
  const digits = input.replace(/[^\d]/g, '');
  if (digits.length <= 4) return '****';
  return `***${digits.slice(-4)}`;
}

function parseTwilioError(text: string): { code?: number; message?: string } {
  try {
    const j = JSON.parse(text);
    return { code: typeof j?.code === 'number' ? j.code : undefined, message: typeof j?.message === 'string' ? j.message : undefined };
  } catch {
    return {};
  }
}

export function hasTwilioVerifyEnabled(): boolean {
  return Boolean(process.env.TWILIO_VERIFY_SERVICE_SID?.trim());
}

export async function sendTwilioVerifySms(params: { toE164: string; locale?: string }): Promise<void> {
  const accountSid = requireEnv('TWILIO_ACCOUNT_SID');
  const authToken = requireEnv('TWILIO_AUTH_TOKEN');
  const serviceSid = requireEnv('TWILIO_VERIFY_SERVICE_SID');

  const url = `https://verify.twilio.com/v2/Services/${encodeURIComponent(serviceSid)}/Verifications`;
  const form = new URLSearchParams();
  form.set('To', params.toE164);
  form.set('Channel', 'sms');
  if (params.locale?.trim()) form.set('Locale', params.locale.trim());

  const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString()
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const parsed = parseTwilioError(text);

    let msg = "Impossible d'envoyer le code. Veuillez réessayer.";
    if (res.status === 429 || parsed.code === 20429) {
      msg = 'Trop de demandes. Veuillez attendre 10 minutes.';
    }

    const err: any = new Error(msg);
    err.status = res.status === 429 ? 429 : 502;
    err.twilio = {
      provider: 'verify',
      status: res.status,
      code: parsed.code,
      to: maskPhoneForLogs(params.toE164),
      resp: text.slice(0, 500)
    };
    throw err;
  }
}

export async function checkTwilioVerifyCode(params: {
  toE164: string;
  code: string;
}): Promise<{ approved: true } | { approved: false; reason: 'incorrect' | 'expired' | 'too_many_attempts' }> {
  const accountSid = requireEnv('TWILIO_ACCOUNT_SID');
  const authToken = requireEnv('TWILIO_AUTH_TOKEN');
  const serviceSid = requireEnv('TWILIO_VERIFY_SERVICE_SID');

  const url = `https://verify.twilio.com/v2/Services/${encodeURIComponent(serviceSid)}/VerificationCheck`;
  const form = new URLSearchParams();
  form.set('To', params.toE164);
  form.set('Code', params.code);

  const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString()
  });

  const text = await res.text().catch(() => '');
  const parsedErr = parseTwilioError(text);

  if (!res.ok) {
    const msgRaw = (parsedErr.message || text || '').toLowerCase();
    if (res.status === 429 || parsedErr.code === 20429) {
      return { approved: false, reason: 'too_many_attempts' };
    }
    if (msgRaw.includes('expired') || msgRaw.includes('not found') || res.status === 404) {
      return { approved: false, reason: 'expired' };
    }
    // Par défaut: incorrect
    return { approved: false, reason: 'incorrect' };
  }

  // Réponse OK: status="approved" ou "pending"
  try {
    const j = JSON.parse(text);
    if (j?.status === 'approved') return { approved: true };
    return { approved: false, reason: 'incorrect' };
  } catch {
    return { approved: false, reason: 'incorrect' };
  }
}


