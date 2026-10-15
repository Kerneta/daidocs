// Anthropic Messages API provider. Requires ANTHROPIC_API_KEY in the environment.
// Supports automatic ephemeral prompt caching (cache_control), transient retry/backoff,
// and token/cache telemetry while preserving the complete({ system, prompt, maxTokens }) -> string contract.

const DEFAULT_MIN_CACHE_CHARS = 4096; // ~1,024 tokens (Anthropic minimum cacheable prefix)
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);

// Splits a DaiDocs reader/ingest prompt into cacheable static prefix block(s) and dynamic
// question/tail block(s) when the prefix is large enough for Anthropic ephemeral caching.
// Breakpoint budget: at most 1 on system + at most 2 on user content (<= 3 total, within
// Anthropic's 4-breakpoint limit).
function buildCachedPayload({ system = '', prompt = '', cacheControl = true, minCacheChars = DEFAULT_MIN_CACHE_CHARS }) {
  const cachingEnabled = cacheControl !== false && !process.env.DAIDOCS_NO_PROMPT_CACHE;
  const sysText = String(system || '');
  const promptText = String(prompt || '');

  let systemPayload = sysText || undefined;
  if (cachingEnabled && sysText.length >= minCacheChars) {
    systemPayload = [{ type: 'text', text: sysText, cache_control: { type: 'ephemeral' } }];
  }

  if (!cachingEnabled || promptText.length < minCacheChars) {
    return {
      system: systemPayload,
      messages: [{ role: 'user', content: promptText }],
      cacheBreakpoints: Array.isArray(systemPayload) ? 1 : 0,
    };
  }

  // Reader prompts end with "\n\nQUESTION: ...". Everything before "\n\nQUESTION: " is the
  // assembled CONTEXT (manifest scan + profile + retrieved material).
  const qIdx = promptText.lastIndexOf('\n\nQUESTION: ');
  if (qIdx >= minCacheChars) {
    const contextPart = promptText.slice(0, qIdx);
    const questionPart = promptText.slice(qIdx);

    // Within CONTEXT, the store-wide "# Manifest scan" (+ optional "# profile.dai" /
    // "# Every session, compact extracted facts") prefix is shared across questions on
    // the same store. Place an inner breakpoint after the store-wide header when both
    // the store-wide prefix and the per-question retrieved tail are substantial.
    const dynMarkers = [
      '\n\n---\ndaidocs:',
      '\n\n# Event table:',
      '\n\n# Facts timeline:',
      '\n\n# Calendar resolution',
      '\n\n--- original content',
      '\n\n# Complete original content',
    ];
    let splitIdx = -1;
    for (const m of dynMarkers) {
      const idx = contextPart.indexOf(m);
      if (idx >= minCacheChars && (splitIdx === -1 || idx < splitIdx)) splitIdx = idx;
    }

    if (splitIdx >= minCacheChars && (contextPart.length - splitIdx) >= 512) {
      const storePrefix = contextPart.slice(0, splitIdx);
      const retrievedBlock = contextPart.slice(splitIdx);
      return {
        system: systemPayload,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: storePrefix, cache_control: { type: 'ephemeral' } },
            { type: 'text', text: retrievedBlock, cache_control: { type: 'ephemeral' } },
            { type: 'text', text: questionPart },
          ],
        }],
        cacheBreakpoints: (Array.isArray(systemPayload) ? 1 : 0) + 2,
      };
    }

    return {
      system: systemPayload,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: contextPart, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: questionPart },
        ],
      }],
      cacheBreakpoints: (Array.isArray(systemPayload) ? 1 : 0) + 1,
    };
  }

  // Ingest / generic long prompt: cache the full user block so retries or multi-pass
  // extractions over the same document reuse the prefix.
  return {
    system: systemPayload,
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: promptText, cache_control: { type: 'ephemeral' } }],
    }],
    cacheBreakpoints: (Array.isArray(systemPayload) ? 1 : 0) + 1,
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function create(model = 'claude-sonnet-5', opts = {}) {
  const key = opts.apiKey !== undefined ? opts.apiKey : process.env.ANTHROPIC_API_KEY;
  const fetchFn = opts.fetchImpl || globalThis.fetch;
  const defaultMaxRetries = opts.maxRetries !== undefined ? opts.maxRetries : 3;
  const baseDelayMs = opts.baseDelayMs !== undefined ? opts.baseDelayMs : 500;
  const minCacheChars = opts.minCacheChars !== undefined ? opts.minCacheChars : DEFAULT_MIN_CACHE_CHARS;

  const telemetry = {
    calls: 0,
    retries: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };

  function getTelemetry() {
    const totalInput = telemetry.inputTokens + telemetry.cacheCreationInputTokens + telemetry.cacheReadInputTokens;
    // Anthropic bills cache_read_input_tokens at 0.1x and cache_creation_input_tokens at 1.25x.
    const effectiveInputTokens = telemetry.inputTokens
      + Math.round(telemetry.cacheCreationInputTokens * 1.25)
      + Math.round(telemetry.cacheReadInputTokens * 0.1);
    const tokensSaved = Math.max(0, totalInput - effectiveInputTokens);
    return {
      ...telemetry,
      totalInputTokens: totalInput,
      effectiveInputTokens,
      tokensSaved,
      cacheHitRate: totalInput > 0 ? Number((telemetry.cacheReadInputTokens / totalInput).toFixed(4)) : 0,
    };
  }

  function resetTelemetry() {
    telemetry.calls = 0;
    telemetry.retries = 0;
    telemetry.inputTokens = 0;
    telemetry.outputTokens = 0;
    telemetry.cacheCreationInputTokens = 0;
    telemetry.cacheReadInputTokens = 0;
  }

  const provider = {
    id: 'anthropic', model, live: true,
    lastUsage: null,
    available: () => !!key,
    getTelemetry,
    resetTelemetry,
    async complete({ system = '', prompt, maxTokens = 2048, cacheControl = true, maxRetries = defaultMaxRetries }) {
      if (!key) throw new Error('ANTHROPIC_API_KEY not set');
      // Claude 5-family models reject temperature (retry without it on that error),
      // and thinking tokens count against max_tokens, so thinkers get extra headroom
      // or a tight budget is consumed by thinking and returns empty text.
      const thinker = /fable|mythos/i.test(model);
      // Sonnet 5 defaults thinking ON when the field is omitted; pin it off.
      const sonnet5 = /sonnet-5/i.test(model);
      const cached = buildCachedPayload({ system, prompt, cacheControl, minCacheChars });

      const sendOnce = async (withTemp) => fetchFn('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model, max_tokens: thinker ? maxTokens + 2048 : maxTokens,
          ...(thinker ? { output_config: { effort: 'low' } } : {}),
          ...(sonnet5 ? { thinking: { type: 'disabled' } } : {}),
          ...(withTemp && !thinker && !sonnet5 ? { temperature: 0 } : {}),
          system: cached.system,
          messages: cached.messages,
        }),
      });

      const callWithRetry = async (withTemp) => {
        let attempt = 0;
        while (true) {
          let res;
          try {
            res = await sendOnce(withTemp);
          } catch (netErr) {
            if (attempt < maxRetries) {
              attempt++;
              telemetry.retries++;
              if (baseDelayMs > 0) await sleep(baseDelayMs * Math.pow(2, attempt - 1));
              continue;
            }
            throw netErr;
          }
          if (!res.ok && RETRYABLE_STATUS.has(res.status) && attempt < maxRetries) {
            attempt++;
            telemetry.retries++;
            const retryAfter = res.headers && typeof res.headers.get === 'function' ? Number(res.headers.get('retry-after')) : NaN;
            const delay = Number.isFinite(retryAfter) && retryAfter > 0
              ? retryAfter * 1000
              : baseDelayMs * Math.pow(2, attempt - 1);
            if (delay > 0) await sleep(delay);
            continue;
          }
          return res;
        }
      };

      let res = await callWithRetry(true);
      if (!res.ok) {
        const txt = await res.text();
        if (/temperature.*deprecated/i.test(txt)) res = await callWithRetry(false);
        else throw new Error(`anthropic ${res.status}: ${txt.slice(0, 300)}`);
      }
      if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const j = await res.json();
      telemetry.calls++;
      if (j && j.usage) {
        const u = j.usage;
        telemetry.inputTokens += Number(u.input_tokens || 0);
        telemetry.outputTokens += Number(u.output_tokens || 0);
        telemetry.cacheCreationInputTokens += Number(u.cache_creation_input_tokens || 0);
        telemetry.cacheReadInputTokens += Number(u.cache_read_input_tokens || 0);
        provider.lastUsage = u;
      }
      return (j.content || []).map(b => b.text || '').join('');
    },
  };
  return provider;
}

module.exports = { create, buildCachedPayload, DEFAULT_MIN_CACHE_CHARS };
