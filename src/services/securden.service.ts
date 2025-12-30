type SecurdenResult = {
  folderId?: string;
  accountId?: string;
  warnings: string[];
};

function getSecurdenBaseUrl(): string {
  const raw = (process.env.SECURDEN_BASE_URL || 'https://olimservice.securden-vault.com/api/').trim();
  // Normalise: exactement un "/" final
  return raw.replace(/\/+$/, '') + '/';
}

function parseIdFromResponse(data: any, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = data?.[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return undefined;
}

async function securdenPostJson<T = any>(path: string, body: unknown, signal: AbortSignal): Promise<{ ok: boolean; status: number; data?: T }> {
  const token = process.env.SECURDEN_AUTH_TOKEN || '';
  const baseUrl = getSecurdenBaseUrl();
  const url = baseUrl + path.replace(/^\/+/, '');

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Securden utilise typiquement un header "authtoken"
      authtoken: token
    },
    body: JSON.stringify(body),
    signal
  });

  const status = res.status;
  const text = await res.text().catch(() => '');
  let data: any = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
  }

  return { ok: res.ok, status, data };
}

export function normalizeCardNumberDigitsOnly(value: unknown): { digitsOnly: string; ok: boolean } {
  const raw = typeof value === 'string' ? value : '';
  const digitsOnly = raw.replace(/\D+/g, '');
  // On accepte (très) large : 12-19 digits
  const ok = digitsOnly.length >= 12 && digitsOnly.length <= 19;
  return { digitsOnly, ok };
}

export async function tryCreateSecurdenFolderAndCard(params: {
  firstName: string;
  lastName: string;
  isPayingClient: boolean;
  cardNumber?: unknown;
  expirationDate?: unknown;
  cvv?: unknown;
}): Promise<SecurdenResult> {
  const warnings: string[] = [];
  const token = process.env.SECURDEN_AUTH_TOKEN;
  if (!token?.trim()) {
    warnings.push('SECURDEN_AUTH_TOKEN manquant : intégration Securden ignorée.');
    return { warnings };
  }

  const baseUrl = getSecurdenBaseUrl();
  if (!baseUrl.toLowerCase().startsWith('https://')) {
    warnings.push('Securden: SECURDEN_BASE_URL doit être en HTTPS (TLS obligatoire).');
    return { warnings };
  }

  const folderName = `${params.firstName}`.trim() && `${params.lastName}`.trim()
    ? `${params.firstName} ${params.lastName}`.trim()
    : `${params.firstName || params.lastName || 'Client'}`.trim();

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6500);

  try {
    // 1) Create folder
    const folderPayloadVariants = [{ name: folderName }, { folderName }, { FolderName: folderName }];
    let folderId: string | undefined;
    for (const body of folderPayloadVariants) {
      const r = await securdenPostJson('folders', body, ctrl.signal).catch((e) => {
        // Ne pas inclure le body dans l'erreur (éviter fuite)
        throw e;
      });
      if (!r.ok) continue;
      folderId =
        parseIdFromResponse(r.data, ['id', 'folderId', 'folderID', 'folder_id']) ||
        parseIdFromResponse((r.data as any)?.data, ['id', 'folderId', 'folderID', 'folder_id']);
      if (folderId) break;
    }

    if (!folderId) {
      warnings.push('Securden: échec création folder.');
      return { warnings };
    }

    // 2) Optionnel: create card account (best effort)
    let accountId: string | undefined;
    if (params.isPayingClient) {
      const norm = normalizeCardNumberDigitsOnly(params.cardNumber);
      const exp = typeof params.expirationDate === 'string' ? params.expirationDate.trim() : '';
      const cvv = typeof params.cvv === 'string' ? params.cvv.trim() : '';

      if (norm.ok && exp && cvv) {
        // Ne jamais logguer / retourner ces valeurs.
        const accountPayloadVariants = [
          {
            folderId,
            name: 'Carte bancaire',
            accountType: 'Credit Card',
            fields: { cardNumber: norm.digitsOnly, expirationDate: exp, cvv }
          },
          {
            folderId,
            title: 'Carte bancaire',
            accountType: 'Credit Card',
            attributes: { cardNumber: norm.digitsOnly, expirationDate: exp, cvv }
          }
        ];

        for (const body of accountPayloadVariants) {
          const r = await securdenPostJson('accounts', body, ctrl.signal);
          if (!r.ok) continue;
          accountId =
            parseIdFromResponse(r.data, ['id', 'accountId', 'accountID', 'account_id']) ||
            parseIdFromResponse((r.data as any)?.data, ['id', 'accountId', 'accountID', 'account_id']);
          if (accountId) break;
        }

        if (!accountId) warnings.push('Securden: folder créé mais échec création account carte.');
      } else {
        warnings.push('Securden: client payant mais carte incomplète/invalid (account non créé).');
      }
    }

    return { folderId, accountId, warnings };
  } catch (e: any) {
    if (e?.name === 'AbortError') warnings.push('Securden: timeout.');
    else warnings.push('Securden: erreur API.');
    return { warnings };
  } finally {
    clearTimeout(t);
  }
}


