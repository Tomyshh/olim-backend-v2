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

function escapeXml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function unescapeXml(input: string): string {
  return input
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function extractTagValue(xml: string, tagName: string): string | null {
  const re = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  const m = xml.match(re);
  if (!m) return null;
  return unescapeXml(String(m[1] ?? '').trim());
}

function getGlobalSmsConfig(): {
  apiKey: string;
  originator: string;
  endpointUrl: string;
  soapNs: string;
  addInf: string;
  destinationFormat: 'digits' | 'e164';
} {
  const apiKey = requireEnv('GLOBAL_SMS_API');
  const originator = requireEnv('GLOBAL_SMS_ORIGINATOR');
  const endpointUrl = (process.env.GLOBAL_SMS_ENDPOINT_URL || 'http://api.itnewsletter.co.il/webservices/WsSMS.asmx').trim();
  const soapNs = (process.env.GLOBAL_SMS_SOAP_NS || 'apiGlobalSms').trim();
  const addInf = (process.env.GLOBAL_SMS_ADD_INF || 'olimotp').trim().slice(0, 15) || 'olimotp';
  const destinationFormat = (process.env.GLOBAL_SMS_DESTINATION_FORMAT || 'digits').trim().toLowerCase() === 'e164' ? 'e164' : 'digits';
  return { apiKey, originator, endpointUrl, soapNs, addInf, destinationFormat };
}

function normalizeDestination(toE164: string, format: 'digits' | 'e164'): string {
  if (format === 'e164') return toE164;
  // Par défaut on envoie des digits only (sans '+') => ex: +972501112233 => 972501112233
  return toE164.replace(/[^\d]/g, '');
}

export async function sendSmsViaGlobalSms(params: { toE164: string; message: string }): Promise<{ charged: string }> {
  const cfg = getGlobalSmsConfig();
  const destinations = normalizeDestination(params.toE164, cfg.destinationFormat);

  const soapEnvelope =
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">' +
    '<soap12:Body>' +
    `<sendSmsToRecipients xmlns="${escapeXml(cfg.soapNs)}">` +
    `<ApiKey>${escapeXml(cfg.apiKey)}</ApiKey>` +
    `<txtOriginator>${escapeXml(cfg.originator)}</txtOriginator>` +
    `<destinations>${escapeXml(destinations)}</destinations>` +
    `<txtSMSmessage>${escapeXml(params.message)}</txtSMSmessage>` +
    '<dteToDeliver></dteToDeliver>' +
    `<txtAddInf>${escapeXml(cfg.addInf)}</txtAddInf>` +
    '</sendSmsToRecipients>' +
    '</soap12:Body>' +
    '</soap12:Envelope>';

  const res = await fetch(cfg.endpointUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml; charset=utf-8',
      SOAPAction: `${cfg.soapNs}/sendSmsToRecipients`
    },
    body: soapEnvelope
  });

  const text = await res.text().catch(() => '');
  const result = extractTagValue(text, 'sendSmsToRecipientsResult') || extractTagValue(text, 'sendSmsToRecipientsResponse');

  if (!res.ok) {
    const err: any = new Error("Impossible d'envoyer le code. Veuillez réessayer.");
    err.status = 502;
    err.sms = {
      provider: 'global_sms',
      status: res.status,
      to: maskPhoneForLogs(params.toE164),
      resp: text.slice(0, 700)
    };
    throw err;
  }

  // La doc indique un string:
  // - Succès: "Total balance charged..." (souvent numérique)
  // - Échec: "invalid login", "empty message", etc.
  const normalized = String(result ?? '').trim();
  const isNumeric = /^[+-]?\d+(\.\d+)?$/.test(normalized);

  if (isNumeric) return { charged: normalized };

  const msgLower = normalized.toLowerCase();
  let publicMessage = "Impossible d'envoyer le code. Veuillez réessayer.";
  let status = 502;

  if (msgLower.includes('no valid mobile') || msgLower.includes('wrong date format') || msgLower.includes('originator length') || msgLower.includes('empty message')) {
    // Paramètres côté backend (ou numéro mal formatté)
    status = 400;
  } else if (msgLower.includes('not enough credit')) {
    status = 502;
    publicMessage = "Service SMS indisponible (crédit insuffisant). Veuillez réessayer plus tard.";
  } else if (msgLower.includes('unapproved originator')) {
    status = 502;
    publicMessage = "Service SMS indisponible (numéro d’envoi non approuvé).";
  } else if (msgLower.includes('invalid login') || msgLower === 'e 1' || msgLower.includes('wrong api')) {
    status = 502;
    publicMessage = "Configuration SMS invalide. Contactez le support.";
  }

  const err: any = new Error(publicMessage);
  err.status = status;
  err.sms = {
    provider: 'global_sms',
    to: maskPhoneForLogs(params.toE164),
    result: normalized.slice(0, 200),
    endpoint: cfg.endpointUrl
  };
  throw err;
}


