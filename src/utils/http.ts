export class HttpTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HttpTimeoutError';
  }
}

export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit & { timeoutMs?: number } = {}
): Promise<Response> {
  const timeoutMs = typeof init.timeoutMs === 'number' ? init.timeoutMs : 0;
  if (!timeoutMs || timeoutMs <= 0) {
    // @ts-expect-error (timeoutMs est notre extension)
    const { timeoutMs: _ignored, ...rest } = init;
    return await fetch(input, rest);
  }

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    // @ts-expect-error (timeoutMs est notre extension)
    const { timeoutMs: _ignored, ...rest } = init;
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


