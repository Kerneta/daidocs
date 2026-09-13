// Google Gemini provider. Requires GEMINI_API_KEY.
// Gemini 3 counts thinking against maxOutputTokens; older models reject the thinking
// fields, so try them low and fall back through the config cascade.
function create(model = 'gemini-3-flash-preview') {
  const key = process.env.GEMINI_API_KEY;
  const thinkingConfigs = [{ thinkingLevel: 'low' }, { thinkingBudget: 0 }, null];
  let cfgIdx = 0;
  return {
    id: 'gemini', model, live: true,
    available: () => !!key,
    async complete({ system = '', prompt, maxTokens = 2048 }) {
      if (!key) throw new Error('GEMINI_API_KEY not set');
      while (true) {
        const cfg = thinkingConfigs[cfgIdx];
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: 'POST',
          headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: system ? { parts: [{ text: system }] } : undefined,
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { maxOutputTokens: Math.max(maxTokens, 1024), ...(cfg ? { thinkingConfig: cfg } : {}) }
          })
        });
        if (res.status === 400 && cfgIdx < thinkingConfigs.length - 1) {
          // this model rejects the thinking field; try the next config
          await res.text(); cfgIdx++; continue;
        }
        if (!res.ok) throw new Error(`gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
        const j = await res.json();
        const parts = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
        return parts.filter(p => !p.thought).map(p => p.text || '').join('');
      }
    }
  };
}
module.exports = { create };
