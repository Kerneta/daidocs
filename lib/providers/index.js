// Provider registry. A provider is an LLM backend exposing
// complete({ system, prompt, maxTokens }) -> Promise<string> plus { id, model, live }.

const providers = {
  mock: require('./mock'),
  anthropic: require('./anthropic'),
  gemini: require('./gemini'),
  openai: require('./openai'),
  ollama: require('./ollama'),
  manual: require('./manual'),
};

function getProviders(names) {
  return names.map(n => {
    // Split on the FIRST colon only: Ollama model tags contain colons (e.g. ollama:qwen3:4b).
    const sep = n.indexOf(':');
    const id = sep === -1 ? n : n.slice(0, sep);
    const model = sep === -1 ? undefined : n.slice(sep + 1);
    if (!providers[id]) throw new Error(`Unknown provider "${id}". Available: ${Object.keys(providers).join(', ')}`);
    return providers[id].create(model);
  });
}

module.exports = { getProviders, registry: providers };
