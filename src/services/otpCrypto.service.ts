import crypto from 'crypto';

export function requireOtpSecret(): string {
  const secret = process.env.OTP_HMAC_SECRET;
  if (!secret?.trim()) {
    throw new Error('OTP_HMAC_SECRET is not set');
  }
  return secret;
}

export function generateOtpCode6(): string {
  // 000000..999999 (crypto random)
  const n = crypto.randomInt(0, 1_000_000);
  return n.toString().padStart(6, '0');
}

export function otpCodeHash(secret: string, phoneNumberE164: string, code: string): string {
  const h = crypto.createHmac('sha256', secret);
  h.update(`${phoneNumberE164}:${code}`);
  return h.digest('hex');
}

export function timingSafeEqualHex(aHex: string, bHex: string): boolean {
  try {
    const a = Buffer.from(aHex, 'hex');
    const b = Buffer.from(bHex, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}


