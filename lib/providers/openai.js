// OpenAI Chat Completions provider. Requires OPENAI_API_KEY. Also works for any
// OpenAI-compatible endpoint via OPENAI_BASE_URL (e.g. Groq, Together, vLLM).
function create(model = 'gpt-4o') {
  const key = process.env.OPENAI_API_KEY;
  const base = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
  return {
    id: 'openai', model, live: true,
    available: () => !!key,
    async complete({ system = '', prompt, maxTokens = 2048 }) {
      if (!key) throw new Error('OPENAI_API_KEY not set');
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          // Reasoning models (gpt-5, o-series) reject max_tokens/temperature; they use
          // max_completion_tokens and their own sampling.
          ...(/^(gpt-5|o\d)/i.test(model)
            ? { max_completion_tokens: maxTokens }
            : { max_tokens: maxTokens, temperature: 0 }),
          messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: prompt }]
        })
      });
      if (!res.ok) throw new Error(`openai ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const j = await res.json();
      return j.choices[0].message.content || '';
    }
  };
}
module.exports = { create };
