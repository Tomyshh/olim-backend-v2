export class HttpTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HttpTimeoutError';
  }
}

export async function fetchWithTimeout(
  input: string | URL,
  init: (RequestInit & { timeoutMs?: number }) = {}
): Promise<Response> {
  const { timeoutMs, ...rest } = init;
  const timeout = typeof timeoutMs === 'number' ? timeoutMs : 0;
  if (!timeout || timeout <= 0) {
    return await fetch(input, rest);
  }

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);

  try {
    return await fetch(input, { ...rest, signal: ctrl.signal });
  } catch (e: any) {
    if (e?.name === 'AbortError') {
      throw new HttpTimeoutError('Timeout HTTP.');
    }
    throw e;
  } finally {
    clearTimeout(t);
  }
}


