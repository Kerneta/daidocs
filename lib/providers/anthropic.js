// Anthropic Messages API provider. Requires ANTHROPIC_API_KEY in the environment.
function create(model = 'claude-sonnet-5') {
  const key = process.env.ANTHROPIC_API_KEY;
  return {
    id: 'anthropic', model, live: true,
    available: () => !!key,
    async complete({ system = '', prompt, maxTokens = 2048 }) {
      if (!key) throw new Error('ANTHROPIC_API_KEY not set');
      // Claude 5-family models reject temperature (retry without it on that error),
      // and thinking tokens count against max_tokens, so thinkers get extra headroom
      // or a tight budget is consumed by thinking and returns empty text.
      const thinker = /fable|mythos/i.test(model);
      // Sonnet 5 defaults thinking ON when the field is omitted; pin it off.
      const sonnet5 = /sonnet-5/i.test(model);
      const call = async (withTemp) => fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
          model, max_tokens: thinker ? maxTokens + 2048 : maxTokens,
          ...(thinker ? { output_config: { effort: 'low' } } : {}),
          ...(sonnet5 ? { thinking: { type: 'disabled' } } : {}),
          ...(withTemp && !thinker && !sonnet5 ? { temperature: 0 } : {}),
          system: system || undefined, messages: [{ role: 'user', content: prompt }]
        })
      });
      let res = await call(true);
      if (!res.ok) {
        const txt = await res.text();
        if (/temperature.*deprecated/i.test(txt)) res = await call(false);
        else throw new Error(`anthropic ${res.status}: ${txt.slice(0, 300)}`);
      }
      if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const j = await res.json();
      return j.content.map(b => b.text || '').join('');
    }
  };
}
module.exports = { create };
