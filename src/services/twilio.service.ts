type TwilioSendParams =
  | {
      to: string; // E.164
      body: string;
      messagingServiceSid?: string;
      from?: string; // E.164
    }
  | {
      to: `whatsapp:${string}`; // whatsapp:+E164
      body: string;
      from: `whatsapp:${string}`;
    };

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

export async function sendTwilioMessage(params: TwilioSendParams): Promise<void> {
  const accountSid = requireEnv('TWILIO_ACCOUNT_SID');
  const authToken = requireEnv('TWILIO_AUTH_TOKEN');

  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`;

  const form = new URLSearchParams();
  form.set('To', params.to);
  form.set('Body', params.body);

  if ('messagingServiceSid' in params || 'from' in params) {
    const msid = (params as any).messagingServiceSid as string | undefined;
    const from = (params as any).from as string | undefined;
    if (msid?.trim()) {
      form.set('MessagingServiceSid', msid.trim());
    } else if (from?.trim()) {
      form.set('From', from.trim());
    } else {
      throw new Error('Twilio: MessagingServiceSid ou From est requis pour SMS');
    }
  } else {
    // WhatsApp: From obligatoire
    form.set('From', (params as any).from);
  }

  const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: form.toString()
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `Twilio send failed (${res.status}): to=${maskPhoneForLogs(params.to)} bodyLen=${params.body.length} resp=${text.slice(
        0,
        300
      )}`
    );
  }
}

export async function sendOtpViaTwilio(params: {
  phoneNumberE164: string;
  languageCode?: string;
  channels: Array<'sms' | 'whatsapp'>;
  code: string;
}): Promise<void> {
  const { phoneNumberE164, languageCode, channels, code } = params;

  const fr = `Votre code Olim Service est : ${code}`;
  const en = `Your Olim Service code is: ${code}`;
  const he = `קוד האימות של Olim Service הוא: ${code}`;

  const body =
    (languageCode || 'fr').toLowerCase().startsWith('he') ? he : (languageCode || 'fr').toLowerCase().startsWith('en') ? en : fr;

  const smsFrom = process.env.TWILIO_SMS_FROM?.trim();
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID?.trim();
  const waFrom = process.env.TWILIO_WHATSAPP_FROM?.trim();

  const tasks: Promise<void>[] = [];

  if (channels.includes('sms')) {
    tasks.push(
      sendTwilioMessage({
        to: phoneNumberE164,
        body,
        messagingServiceSid: messagingServiceSid || undefined,
        from: messagingServiceSid ? undefined : smsFrom
      })
    );
  }

  if (channels.includes('whatsapp')) {
    if (!waFrom) throw new Error('TWILIO_WHATSAPP_FROM is not set');
    tasks.push(
      sendTwilioMessage({
        to: `whatsapp:${phoneNumberE164}`,
        from: waFrom.startsWith('whatsapp:') ? (waFrom as any) : (`whatsapp:${waFrom}` as any),
        body
      })
    );
  }

  if (!tasks.length) throw new Error('Aucun channel fourni (sms/whatsapp)');

  // Si un canal échoue, on veut une erreur (l’app affichera un message), mais on conserve le rate-limit côté backend.
  await Promise.all(tasks);
}


