import { runWithConcurrencyLimit } from './concurrencyLimit.service.js';
import { fetchWithTimeout, HttpTimeoutError } from '../utils/http.js';

type OpenAIChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
};

function getOpenAIKey(): string {
  const key = process.env.OPENAI_API_KEY;
  if (!key?.trim()) {
    throw new Error('OPENAI_API_KEY manquante');
  }
  return key.trim();
}

function getOpenAIModel(): string {
  return (process.env.OPENAI_MODEL || 'gpt-4o-mini').trim();
}

function getOpenAIConcurrencyLimit(): number {
  const n = Number(process.env.OPENAI_CHAT_CONCURRENCY || 5);
  return Number.isFinite(n) && n > 0 ? n : 5;
}

function getOpenAITimeoutMs(): number {
  const n = Number(process.env.OPENAI_CHAT_TIMEOUT_MS || 15000);
  return Number.isFinite(n) && n > 0 ? n : 15000;
}

export async function enhanceMessageWithOpenAI(prompt: string): Promise<string> {
  const apiKey = getOpenAIKey();
  const model = getOpenAIModel();

  const payload = {
    model,
    temperature: 0.4,
    max_tokens: 500,
    messages: [
      {
        role: 'system',
        content:
          'Tu es un assistant pour conseillers CRM. Améliore le message fourni (clarté, ton pro, empathie, orthographe) sans changer le sens. Réponds uniquement avec le message final.'
      },
      { role: 'user', content: prompt }
    ]
  };

  let resp: Response;
  try {
    resp = await runWithConcurrencyLimit({
      key: 'openai:chat',
      limit: getOpenAIConcurrencyLimit(),
      waitTimeoutMs: Number(process.env.OPENAI_CHAT_WAIT_TIMEOUT_MS || 5000),
      fn: async () =>
        await fetchWithTimeout('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload),
          timeoutMs: getOpenAITimeoutMs()
        })
    });
  } catch (e: any) {
    if (e?.name === 'ConcurrencyLimitError') {
      throw new Error('Service surchargé. Veuillez réessayer.');
    }
    if (e instanceof HttpTimeoutError) {
      throw new Error('Timeout OpenAI.');
    }
    throw e;
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`OpenAI HTTP ${resp.status}: ${text}`);
  }

  const data = (await resp.json()) as OpenAIChatCompletionResponse;
  const content = data?.choices?.[0]?.message?.content ?? '';
  const enhanced = String(content).trim();

  if (!enhanced) {
    throw new Error('Réponse OpenAI vide');
  }

  return enhanced;
}


