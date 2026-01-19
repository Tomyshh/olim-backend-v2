/**
 * Securden API integration
 * Aligné sur le flux Flutter: add_folder (query) → share_folder (form) → add_account (query)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SecurdenResult = {
  folderId?: string;
  accountId?: string;
  warnings: string[];
};

export type SecurdenCreateCreditCardAccountInput = {
  folderId: string;
  clientName: string;
  cardNumber: unknown;
  expirationDate: unknown;
  cvv: unknown;
  isRegistration?: boolean;
};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function getSecurdenBaseUrl(): string {
  const raw = (process.env.SECURDEN_BASE_URL || 'https://olimservice.securden-vault.com/api/').trim();
  return raw.replace(/\/+$/, '') + '/';
}

function getSecurdenToken(): string {
  return (process.env.SECURDEN_AUTH_TOKEN || '').trim();
}

function getOlimGroupId(): string {
  // ID du groupe Olim Service pour partager les folders
  return (process.env.SECURDEN_OLIM_GROUP_ID || '2000360004083').trim();
}

function isDebug(): boolean {
  return process.env.SECURDEN_DEBUG === 'true';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function maskCard(cardNumber: string): string {
  if (cardNumber.length >= 4) {
    return '***' + cardNumber.slice(-4);
  }
  return '****';
}

function parseIdFromResponse(data: any, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = data?.[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return undefined;
}

export function normalizeCardNumberDigitsOnly(value: unknown): { digitsOnly: string; ok: boolean } {
  const raw = typeof value === 'string' ? value : '';
  const digitsOnly = raw.replace(/\D+/g, '');
  const ok = digitsOnly.length >= 12 && digitsOnly.length <= 19;
  return { digitsOnly, ok };
}

function parseSecurdenAccountId(value: unknown): string {
  // Les IDs Securden semblent tenir dans Number.MAX_SAFE_INTEGER, mais on reste string côté app.
  const s = typeof value === 'string' ? value.trim() : typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
  return s;
}

function logSecurden(endpoint: string, message: string, extra?: Record<string, unknown>): void {
  if (isDebug()) {
    console.log(`[Securden] ${endpoint}: ${message}`, extra ? JSON.stringify(extra) : '');
  }
}

function logSecurdenError(endpoint: string, status: number, respBody: any): void {
  // Log sans données sensibles
  const safeBody = typeof respBody === 'object' && respBody
    ? { code: respBody.code, message: respBody.message, error: respBody.error, status: respBody.status }
    : { raw: String(respBody).slice(0, 200) };
  console.error(`[Securden] ERREUR ${endpoint}: status=${status}`, JSON.stringify(safeBody));
}

// ---------------------------------------------------------------------------
// API Calls (aligned with Flutter)
// ---------------------------------------------------------------------------

/**
 * POST /api/add_folder?folder_name=...
 * Headers: authtoken, Content-Type: application/json
 * Response: { folder_id: number, ... }
 */
async function addFolder(folderName: string, signal: AbortSignal): Promise<{ ok: boolean; folderId?: string; status: number; error?: string }> {
  const baseUrl = getSecurdenBaseUrl();
  const token = getSecurdenToken();
  
  const url = new URL(baseUrl + 'add_folder');
  url.searchParams.set('folder_name', folderName);

  logSecurden('add_folder', `Creating folder: ${folderName}`);

  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      authtoken: token
    },
    signal
  });

  const status = res.status;
  const text = await res.text().catch(() => '');
  let data: any;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }

  if (res.ok) {
    const folderId = parseIdFromResponse(data, ['folder_id', 'folderId', 'folderID', 'id', 'ID']);
    logSecurden('add_folder', `Folder créé: ${folderId}`);
    return { ok: true, folderId, status };
  }

  logSecurdenError('add_folder', status, data);
  return { ok: false, status, error: data?.message || data?.error || `HTTP ${status}` };
}

/**
 * POST /api/share_folder
 * Headers: authtoken, Content-Type: application/x-www-form-urlencoded
 * Body (form): folder_id, group_ids (JSON array string), folder_privilege, account_privilege
 */
async function shareFolder(folderId: string, signal: AbortSignal): Promise<{ ok: boolean; status: number; error?: string }> {
  const baseUrl = getSecurdenBaseUrl();
  const token = getSecurdenToken();
  const groupId = getOlimGroupId();

  const url = baseUrl + 'share_folder';

  const body = new URLSearchParams();
  body.set('folder_id', folderId);
  body.set('group_ids', JSON.stringify([Number(groupId)]));
  body.set('folder_privilege', 'manage_folder');
  body.set('account_privilege', 'manage');

  logSecurden('share_folder', `Sharing folder ${folderId} with group ${groupId}`);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      authtoken: token
    },
    body: body.toString(),
    signal
  });

  const status = res.status;
  const text = await res.text().catch(() => '');
  let data: any;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }

  if (res.ok) {
    logSecurden('share_folder', `Folder ${folderId} partagé avec succès`);
    return { ok: true, status };
  }

  logSecurdenError('share_folder', status, data);
  return { ok: false, status, error: data?.message || data?.error || `HTTP ${status}` };
}

/**
 * POST /api/add_account?account_type=...&folder_id=...&account_title=...&account_name=...&cardNumber=...&expirationDate=...&cvv=...
 * Headers: authtoken, Content-Type: application/json
 * Response: { ID: number, ... }
 */
async function addCreditCardAccount(params: {
  folderId: string;
  clientName: string;
  cardNumber: string;
  expirationDate: string;
  cvv: string;
  isRegistration: boolean;
}, signal: AbortSignal): Promise<{ ok: boolean; accountId?: string; status: number; error?: string }> {
  const baseUrl = getSecurdenBaseUrl();
  const token = getSecurdenToken();

  const maskedCard = maskCard(params.cardNumber);
  const accountTitle = `${params.clientName} - ${maskedCard}`;
  const accountName = params.isRegistration
    ? `${params.clientName} - Registration Card`
    : `${params.clientName} - New card - ${maskedCard}`;

  const url = new URL(baseUrl + 'add_account');
  url.searchParams.set('account_type', 'Credit Card 2');
  url.searchParams.set('folder_id', params.folderId);
  url.searchParams.set('account_title', accountTitle);
  url.searchParams.set('account_name', accountName);
  url.searchParams.set('cardNumber', params.cardNumber);
  url.searchParams.set('expirationDate', params.expirationDate);
  url.searchParams.set('cvv', params.cvv);

  logSecurden('add_account', `Creating card account for ${params.clientName} (${maskedCard}) in folder ${params.folderId}`);

  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      authtoken: token
    },
    signal
  });

  const status = res.status;
  const text = await res.text().catch(() => '');
  let data: any;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }

  if (res.ok) {
    const accountId = parseIdFromResponse(data, ['ID', 'id', 'accountId', 'accountID', 'account_id']);
    logSecurden('add_account', `Account créé: ${accountId}`);
    return { ok: true, accountId, status };
  }

  logSecurdenError('add_account', status, data);
  return { ok: false, status, error: data?.message || data?.error || `HTTP ${status}` };
}

/**
 * DELETE /api/delete_accounts
 * Headers: authtoken, Content-Type: application/x-www-form-urlencoded
 * Body (form): account_ids (JSON array string), delete_permanently (True/False), reason (optional)
 */
async function deleteAccounts(
  params: { accountIds: string[]; deletePermanently: boolean; reason?: string },
  signal: AbortSignal
): Promise<{ ok: boolean; status: number; error?: string }> {
  const baseUrl = getSecurdenBaseUrl();
  const token = getSecurdenToken();

  const url = baseUrl + 'delete_accounts';
  const body = new URLSearchParams();

  const ids = (params.accountIds || [])
    .map((x) => parseSecurdenAccountId(x))
    .filter(Boolean)
    .map((x) => Number(x))
    .filter((n) => Number.isFinite(n));

  body.set('account_ids', JSON.stringify(ids));
  body.set('delete_permanently', params.deletePermanently ? 'True' : 'False');
  if (typeof params.reason === 'string' && params.reason.trim()) {
    body.set('reason', params.reason.trim());
  }

  logSecurden('delete_accounts', `Deleting accounts: ${ids.join(',') || '(none)'}`);

  const res = await fetch(url, {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      authtoken: token
    },
    body: body.toString(),
    signal
  });

  const status = res.status;
  const text = await res.text().catch(() => '');
  let data: any;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }

  if (res.ok) {
    logSecurden('delete_accounts', `Accounts supprimés OK`);
    return { ok: true, status };
  }

  logSecurdenError('delete_accounts', status, data);
  return { ok: false, status, error: data?.message || data?.error || `HTTP ${status}` };
}

export async function deleteSecurdenAccounts(input: {
  accountIds: unknown;
  deletePermanently?: unknown;
  reason?: unknown;
}): Promise<{ ok: boolean; warnings: string[]; status?: number }> {
  const warnings: string[] = [];
  const token = getSecurdenToken();

  if (!token) {
    warnings.push('SECURDEN_AUTH_TOKEN manquant: suppression Securden impossible.');
    return { ok: false, warnings };
  }

  const baseUrl = getSecurdenBaseUrl();
  if (!baseUrl.toLowerCase().startsWith('https://')) {
    warnings.push('Securden: SECURDEN_BASE_URL doit être en HTTPS (TLS obligatoire).');
    return { ok: false, warnings };
  }

  const rawIds = Array.isArray(input.accountIds) ? input.accountIds : [];
  const accountIds = rawIds.map(parseSecurdenAccountId).filter(Boolean);
  if (accountIds.length === 0) {
    warnings.push('Securden: accountIds manquant.');
    return { ok: false, warnings };
  }

  const deletePermanently = input.deletePermanently === true;
  const reason = typeof input.reason === 'string' ? input.reason : '';

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 15000);

  try {
    const result = await deleteAccounts(
      {
        accountIds,
        deletePermanently,
        reason
      },
      ctrl.signal
    );

    if (result.ok) return { ok: true, warnings, status: result.status };
    warnings.push(`Securden: échec suppression account (${result.error || 'status ' + result.status}).`);
    return { ok: false, warnings, status: result.status };
  } catch (e: any) {
    if (e?.name === 'AbortError') {
      warnings.push('Securden: timeout (opération trop longue).');
    } else {
      console.error('[Securden] Exception:', e?.message || e);
      warnings.push('Securden: erreur inattendue.');
    }
    return { ok: false, warnings };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Crée un compte "Credit Card 2" dans un folder Securden existant.
 * - Ne log jamais de données sensibles
 * - Valide/normalise le numéro de carte (digits only)
 */
export async function createSecurdenCreditCardAccountInFolder(
  input: SecurdenCreateCreditCardAccountInput
): Promise<{ accountId?: string; warnings: string[]; status?: number }> {
  const warnings: string[] = [];
  const token = getSecurdenToken();

  if (!token) {
    warnings.push('SECURDEN_AUTH_TOKEN manquant: création de carte Securden ignorée.');
    return { warnings };
  }

  const baseUrl = getSecurdenBaseUrl();
  if (!baseUrl.toLowerCase().startsWith('https://')) {
    warnings.push('Securden: SECURDEN_BASE_URL doit être en HTTPS (TLS obligatoire).');
    return { warnings };
  }

  const folderId = typeof input.folderId === 'string' ? input.folderId.trim() : '';
  const clientName = typeof input.clientName === 'string' ? input.clientName.trim() : '';
  if (!folderId) {
    warnings.push('Securden: folderId manquant.');
    return { warnings };
  }
  if (!clientName) {
    warnings.push('Securden: clientName manquant.');
    return { warnings };
  }

  const norm = normalizeCardNumberDigitsOnly(input.cardNumber);
  const expirationDate = typeof input.expirationDate === 'string' ? input.expirationDate.trim() : '';
  const cvv = typeof input.cvv === 'string' ? input.cvv.trim() : '';
  if (!norm.ok || !expirationDate || !cvv) {
    warnings.push('Securden: carte incomplète/invalide (account non créé).');
    return { warnings };
  }

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 15000);

  try {
    const accountResult = await addCreditCardAccount(
      {
        folderId,
        clientName,
        cardNumber: norm.digitsOnly,
        expirationDate,
        cvv,
        isRegistration: input.isRegistration === true
      },
      ctrl.signal
    );

    if (accountResult.ok && accountResult.accountId) {
      return { accountId: accountResult.accountId, warnings, status: accountResult.status };
    }

    warnings.push(`Securden: échec création account (${accountResult.error || 'status ' + accountResult.status}).`);
    return { warnings, status: accountResult.status };
  } catch (e: any) {
    if (e?.name === 'AbortError') {
      warnings.push('Securden: timeout (opération trop longue).');
    } else {
      console.error('[Securden] Exception:', e?.message || e);
      warnings.push('Securden: erreur inattendue.');
    }
    return { warnings };
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function tryCreateSecurdenFolderAndCard(params: {
  firstName: string;
  lastName: string;
  isPayingClient: boolean;
  cardNumber?: unknown;
  expirationDate?: unknown;
  cvv?: unknown;
}): Promise<SecurdenResult> {
  const warnings: string[] = [];
  const token = getSecurdenToken();

  if (!token) {
    warnings.push('SECURDEN_AUTH_TOKEN manquant: intégration Securden ignorée.');
    return { warnings };
  }

  const baseUrl = getSecurdenBaseUrl();
  if (!baseUrl.toLowerCase().startsWith('https://')) {
    warnings.push('Securden: SECURDEN_BASE_URL doit être en HTTPS (TLS obligatoire).');
    return { warnings };
  }

  const folderName = `${params.firstName || ''}`.trim() && `${params.lastName || ''}`.trim()
    ? `${params.firstName} ${params.lastName}`.trim()
    : `${params.firstName || params.lastName || 'Client'}`.trim();

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 15000); // 15s pour les 3 appels

  try {
    // 1) Create folder
    const folderResult = await addFolder(folderName, ctrl.signal);
    if (!folderResult.ok || !folderResult.folderId) {
      warnings.push(`Securden: échec création folder (${folderResult.error || 'status ' + folderResult.status}).`);
      return { warnings };
    }

    const folderId = folderResult.folderId;

    // 2) Share folder with Olim Service group
    const shareResult = await shareFolder(folderId, ctrl.signal);
    if (!shareResult.ok) {
      // Non bloquant: on continue même si le partage échoue
      warnings.push(`Securden: folder créé mais partage échoué (${shareResult.error || 'status ' + shareResult.status}).`);
    }

    // 3) Create card account (only for paying clients with valid card data)
    let accountId: string | undefined;
    if (params.isPayingClient) {
      const norm = normalizeCardNumberDigitsOnly(params.cardNumber);
      const exp = typeof params.expirationDate === 'string' ? params.expirationDate.trim() : '';
      const cvv = typeof params.cvv === 'string' ? params.cvv.trim() : '';

      if (norm.ok && exp && cvv) {
        const accountResult = await addCreditCardAccount({
          folderId,
          clientName: folderName,
          cardNumber: norm.digitsOnly,
          expirationDate: exp,
          cvv,
          isRegistration: true
        }, ctrl.signal);

        if (accountResult.ok && accountResult.accountId) {
          accountId = accountResult.accountId;
        } else {
          warnings.push(`Securden: folder créé mais échec création account (${accountResult.error || 'status ' + accountResult.status}).`);
        }
      } else {
        warnings.push('Securden: client payant mais carte incomplète/invalide (account non créé).');
      }
    }

    return { folderId, accountId, warnings };
  } catch (e: any) {
    if (e?.name === 'AbortError') {
      warnings.push('Securden: timeout (opération trop longue).');
    } else {
      console.error('[Securden] Exception:', e?.message || e);
      warnings.push('Securden: erreur inattendue.');
    }
    return { warnings };
  } finally {
    clearTimeout(timeout);
  }
}
