// Baseline: deterministic clean to plain text (strip HTML/boilerplate), still one file
// read whole at query time. Isolates the value of cleaning alone, no LLM cost at ingest.

const { countTokens } = require('../../tokens');

function clean(text) {
  let t = String(text);
  if (/<\/?(html|body|div|p|span|script|style)\b/i.test(t)) {
    t = t.replace(/<script[\s\S]*?<\/script>/gi, ' ')
         .replace(/<style[\s\S]*?<\/style>/gi, ' ')
         .replace(/<!--[\s\S]*?-->/g, ' ')
         .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
         .replace(/<[^>]+>/g, ' ')
         .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  }
  return t.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

module.exports = {
  id: 'clean-md',
  version: '1.0',
  description: 'Deterministic boilerplate-stripped plain text; whole-document reads.',
  clean,

  async ingest(item) {
    return { files: [{ path: `${item.id}.md`, content: `# ${item.title}\n\n${clean(item.raw ?? item.text)}` }], tokensIn: 0, tokensOut: 0, calls: 0 };
  },

  async answer(question, store, provider) {
    const doc = Object.values(store.files)[0];
    const prompt = `Answer strictly from the document below.\n\nQUESTION: ${question.text}\n\nDOCUMENT:\n${doc}`;
    const answer = await provider.complete({ prompt, maxTokens: 400 });
    return { answer, contextTokens: countTokens(prompt), calls: 1 };
  }
};
