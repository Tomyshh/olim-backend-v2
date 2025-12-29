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
    const err: any = new Error("Erreur lors de l'envoi du message.");
    err.status = 502;
    err.twilio = {
      status: res.status,
      to: maskPhoneForLogs(params.to),
      bodyLen: params.body.length,
      resp: text.slice(0, 500)
    };
    throw err;
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

  const tasks: Array<Promise<{ channel: 'sms' | 'whatsapp'; ok: true } | { channel: 'sms' | 'whatsapp'; ok: false; error: any }>> = [];

  const safeSend = async (
    channel: 'sms' | 'whatsapp',
    fn: () => Promise<void>
  ): Promise<{ channel: 'sms' | 'whatsapp'; ok: true } | { channel: 'sms' | 'whatsapp'; ok: false; error: any }> => {
    try {
      await fn();
      return { channel, ok: true };
    } catch (error: any) {
      return { channel, ok: false, error };
    }
  };

  if (channels.includes('sms')) {
    tasks.push(
      safeSend('sms', () =>
        sendTwilioMessage({
          to: phoneNumberE164,
          body,
          messagingServiceSid: messagingServiceSid || undefined,
          from: messagingServiceSid ? undefined : smsFrom
        })
      )
    );
  }

  if (channels.includes('whatsapp')) {
    // Si WhatsApp n'est pas configuré, on ignore silencieusement (SMS suffit pour auth).
    if (waFrom) {
      tasks.push(
        safeSend('whatsapp', () =>
          sendTwilioMessage({
            to: `whatsapp:${phoneNumberE164}`,
            from: waFrom.startsWith('whatsapp:') ? (waFrom as any) : (`whatsapp:${waFrom}` as any),
            body
          })
        )
      );
    }
  }

  if (!tasks.length) {
    const err: any = new Error('Aucun channel disponible.');
    err.status = 400;
    throw err;
  }

  const results = await Promise.all(tasks);
  const anyOk = results.some((r) => r.ok);
  if (!anyOk) {
    // Aucun canal n’a fonctionné → on remonte une erreur propre côté client.
    const first = results.find((r) => !r.ok) as any;
    const err: any = new Error("Impossible d'envoyer le code. Veuillez réessayer.");
    err.status = first?.error?.status || 502;
    err.cause = first?.error;
    throw err;
  }

  // Si WhatsApp échoue mais SMS OK, on log côté serveur sans casser le flow utilisateur.
  const waFailed = results.find((r) => r.channel === 'whatsapp' && !r.ok) as any;
  if (waFailed?.error) {
    console.warn('⚠️ WhatsApp OTP send failed (ignored):', waFailed.error?.twilio || waFailed.error?.message || waFailed.error);
  }
}


