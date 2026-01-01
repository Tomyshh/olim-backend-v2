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

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

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


