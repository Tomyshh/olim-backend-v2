/**
 * Génère le Client Secret (JWT) pour "Sign in with Apple" utilisé par Supabase.
 * Usage: node generate_apple_secret.js
 */

import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TEAM_ID = 'PJ8VG3TYWJ';
const SERVICES_ID = 'com.iosversion.olimservice';
const KEY_ID = '232RP8PWHA';
const P8_PATH = path.join(__dirname, 'AuthKey_232RP8PWHA.p8');

const privateKey = fs.readFileSync(P8_PATH, 'utf8');

const now = Math.floor(Date.now() / 1000);
const payload = {
  iss: TEAM_ID,
  iat: now,
  exp: now + 15777000, // ~6 mois (max autorisé par Apple)
  aud: 'https://appleid.apple.com',
  sub: SERVICES_ID,
};

const header = {
  alg: 'ES256',
  kid: KEY_ID,
};

const clientSecret = jwt.sign(payload, privateKey, {
  algorithm: 'ES256',
  header: { ...header },
});

console.log('\n=== Apple Client Secret (JWT) ===\n');
console.log(clientSecret);
console.log('\n=== Copiez le JWT ci-dessus dans Supabase (Apple Provider > Client Secret) ===\n');
