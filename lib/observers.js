// The observer catalogue offered at install. The observer reads each document once at
// ingest and writes its Understanding block, so quality is baked in permanently while
// cost is paid once — hence a capable default. Prices are list rates, a guide not a quote.

const PROVIDER_KEYS = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  gemini: 'GEMINI_API_KEY',
  ollama: null,
  mock: null,
  manual: null,
};

// Providers setup steers people to (the map above is the wider set keyVarFor() answers
// for). Local models are deliberately absent: the ollama backend works but is untested
// for extraction quality here, so it's never offered (set DAIDOCS_OBSERVER by hand).
const OFFERED_PROVIDERS = ['openai', 'anthropic', 'gemini'];

const CATALOGUE = [
  {
    spec: 'openai:gpt-4.1-mini',
    label: 'OpenAI GPT-4.1 mini',
    note: 'recommended with an API key: the cheapest accurate converter, the observer behind the published numbers, and roughly 13x cheaper than Opus for the same conversion',
    price: 'about $0.40 / $1.60 per million tokens',
  },
  {
    spec: 'anthropic:claude-opus-5',
    label: 'Claude Opus 5',
    note: 'the default when no choice is made under Claude, and the richer extraction',
    price: '$5 / $25 per million tokens',
  },
  {
    spec: 'anthropic:claude-fable-5-1',
    label: 'Claude Fable 5.1',
    note: 'most capable model available, for the richest extraction',
    price: '$10 / $50 per million tokens',
  },
  {
    spec: null,
    label: 'Add my own model',
    note: 'any provider:model, with an optional custom endpoint',
    price: '',
  },
];

const providerOf = spec => String(spec || '').split(':')[0];
const keyVarFor = spec => PROVIDER_KEYS[providerOf(spec)] || null;
const needsKey = spec => !!keyVarFor(spec);

function isKnownProvider(spec) {
  return Object.prototype.hasOwnProperty.call(PROVIDER_KEYS, providerOf(spec));
}

// Order depends on the host: under Claude, Claude models lead (the user has a
// subscription and usually a key); under ChatGPT, GPT-4.1 mini leads. Under Claude the
// hooks don't call an API (they save the transcript for the next session to convert
// free); DAIDOCS_USE_API=1 opts into billing, which is why the price still shows.
function catalogueFor(host) {
  if (host !== 'anthropic') return CATALOGUE;
  const by = spec => CATALOGUE.find(o => o.spec === spec);
  const claudeFirst = ['anthropic:claude-opus-5', 'anthropic:claude-fable-5-1']
    .map(by).filter(Boolean)
    .map((o, i) => ({
      ...o,
      // no API price here: nothing is billed on a subscription, so the number only
      // confused; --status and the guide still carry rates for DAIDOCS_USE_API=1.
      price: i === 0 ? 'recommended on a Claude subscription' : '',
      free: true,
      note: 'free on your Claude subscription. Conversion happens inside your session, where this assistant writes the extraction itself, so no API key is used and nothing is billed.',
    }));
  const rest = CATALOGUE.filter(o => !claudeFirst.some(c => c.spec === o.spec));
  return [...claudeFirst, ...rest];
}

// Shown on the menu so a model list under a memory question isn't misread as "pick the
// model you'll talk to".
const WHAT_THIS_IS = [
  '  This is only the model that converts a conversation into the .dai format. It',
  '  runs once per document, over a small amount of text, and it is not the model',
  '  you talk to: carry on using whatever you like for the session itself.',
];
// Said only where there is something above it to point at.
const FREE_ONES_ARE_ENOUGH = '  The two above convert accurately and cost nothing on your subscription.';

function renderMenu(host) {
  const list = catalogueFor(host);
  const lines = ['', '  Which model should read your conversations into memory?', ''];
  const lastFree = list.reduce((at, o, i) => (o.free ? i : at), -1);
  list.forEach((o, i) => {
    lines.push(`   ${i + 1}. ${o.label}${o.price ? `  (${o.price})` : ''}`);
    lines.push(`      ${o.note}`);
    if (i === lastFree) lines.push('', ...WHAT_THIS_IS, FREE_ONES_ARE_ENOUGH, '');
  });
  // nothing free under this host, so the paragraph goes at the top as context
  if (lastFree < 0) lines.splice(3, 0, ...WHAT_THIS_IS, '');
  lines.push('');
  lines.push('  Whichever you pick, the store keeps the original text, so converting again');
  lines.push('  later with a different model is always possible.');
  lines.push('');
  return lines.join('\n');
}

// ask: async (question) => string. Returns { spec, keyVar, baseUrl } or null if
// the person declined to choose.
async function pickObserver(ask, log, host = null) {
  const list = catalogueFor(host);
  console.log(renderMenu(host));
  const answer = (await ask(`  Choose 1 to ${list.length} [1]: `)) || '1';
  const idx = parseInt(answer, 10);
  if (!(idx >= 1 && idx <= list.length)) {
    log(`"${answer}" is not one of the options; using ${list[0].spec}.`);
    return { spec: list[0].spec, keyVar: keyVarFor(list[0].spec), baseUrl: null };
  }

  const chosen = list[idx - 1];
  if (chosen.spec) return { spec: chosen.spec, keyVar: keyVarFor(chosen.spec), baseUrl: null };

  // "Add my own model"
  console.log('');
  console.log('  Give the model as provider:model. Examples:');
  console.log('    anthropic:claude-opus-4-8      a specific Claude version');
  console.log('    openai:gpt-4o                  any OpenAI model id');
  console.log('    gemini:gemini-2.5-flash        any Gemini model id');
  console.log('    openai:my-model                plus a custom endpoint on the next question,');
  console.log('                                   which is how you reach any OpenAI-compatible');
  console.log('                                   server: vLLM, Groq, Together');
  console.log('');
  let spec = '';
  while (!spec) {
    spec = (await ask('  provider:model: ')).trim();
    if (!spec) return null;
    if (!spec.includes(':')) { log(`"${spec}" needs a provider prefix, for example openai:${spec}`); spec = ''; continue; }
    if (!OFFERED_PROVIDERS.includes(providerOf(spec))) {
      log(`"${providerOf(spec)}" is not offered. Use one of: ${OFFERED_PROVIDERS.join(', ')}.`);
      spec = '';
    }
  }

  let baseUrl = null;
  if (providerOf(spec) === 'openai') {
    const u = (await ask('  Custom endpoint URL, or Enter for the OpenAI default: ')).trim();
    if (u) baseUrl = u;
  }
  return { spec, keyVar: keyVarFor(spec), baseUrl };
}

module.exports = { CATALOGUE, catalogueFor, PROVIDER_KEYS, OFFERED_PROVIDERS, providerOf, keyVarFor, needsKey, isKnownProvider, renderMenu, pickObserver };
