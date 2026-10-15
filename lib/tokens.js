// Token counting, context-budget chunking/pruning, and prompt-cache savings estimation.
// Primary: gpt-tokenizer (offline); fallback: a chars/4-plus-words estimator so a machine
// without node_modules still works. The counter used is recorded per result row;
// mixed-counter comparisons are invalid.

let enc = null;
let TOKENIZER_ID = 'estimator:v1(chars/4~words*1.33)';
for (const p of ['gpt-tokenizer', require('path').join(__dirname, '..', '..', 'benchmark', 'node_modules', 'gpt-tokenizer')]) {
  try {
    enc = require(p);
    try { TOKENIZER_ID = 'gpt-tokenizer@' + require(p + '/package.json').version; }
    catch (_) { TOKENIZER_ID = 'gpt-tokenizer@unknown'; }
    break;
  } catch (_) { }
}

function countTokens(text) {
  if (text == null) return 0;
  const s = String(text);
  if (enc && enc.encode) {
    // real-world content can contain literal special tokens ("<|endoftext|>");
    // count them as plain text instead of letting the tokenizer throw
    try { return enc.encode(s).length; }
    catch (_) { return enc.encode(s.replace(/<\|[a-z_]+\|>/gi, ' ')).length; }
  }
  const words = (s.match(/\S+/g) || []).length;
  return Math.round((s.length / 4 + words * 1.33) / 2);
}

// Splits text into token-budgeted chunks while respecting turn, paragraph, and sentence
// boundaries. If a single paragraph exceeds maxTokens (e.g. a minified dump or long log),
// it falls back to sentence/line and character slicing so no chunk exceeds maxTokens.
function chunkByTokenBudget(text, { targetTokens = 3000, maxTokens = 6000, overlapTokens = 0 } = {}) {
  const s = String(text || '');
  if (!s.trim()) return [];
  const cap = Math.max(targetTokens, maxTokens);
  const blocks = s.split(/\n(?=\[(?:USER|ASSISTANT)\]:)|\n\s*\n/);
  const units = [];

  for (const b of blocks) {
    if (!b) continue;
    if (countTokens(b) <= cap) {
      units.push(b);
      continue;
    }
    // Oversized block fallback: split by line/sentence first, then hard-slice if needed.
    const subParts = b.split(/(?<=[.!?])\s+|\n/);
    for (const sp of subParts) {
      if (!sp) continue;
      if (countTokens(sp) <= cap) {
        units.push(sp);
      } else {
        const approxChars = Math.max(200, Math.floor(targetTokens * 3.5));
        for (let i = 0; i < sp.length; i += approxChars) {
          units.push(sp.slice(i, i + approxChars));
        }
      }
    }
  }

  const chunks = [];
  let cur = [];
  let curTok = 0;
  for (const u of units) {
    const t = countTokens(u);
    if (curTok + t > targetTokens && cur.length) {
      chunks.push(cur.join('\n\n'));
      if (overlapTokens > 0) {
        const carry = [];
        let carryTok = 0;
        for (let i = cur.length - 1; i >= 0; i--) {
          const ut = countTokens(cur[i]);
          if (carryTok + ut > overlapTokens) break;
          carry.unshift(cur[i]);
          carryTok += ut;
        }
        cur = carry;
        curTok = carryTok;
      } else {
        cur = [];
        curTok = 0;
      }
    }
    cur.push(u);
    curTok += t;
  }
  if (cur.length) chunks.push(cur.join('\n\n'));
  return chunks;
}

// Prunes a context string to fit strictly within maxTokens while preserving the structural
// head (e.g. manifest/instructions), evenly sampled middle anchors when multi-paragraph,
// and recent tail.
function pruneContextWindow(text, {
  maxTokens = 25000,
  headRatio = 0.6,
  marker = '\n[... context pruned to fit token budget ...]\n',
} = {}) {
  const s = String(text || '');
  const totalTok = countTokens(s);
  if (totalTok <= maxTokens) return s;

  const markerTok = countTokens(marker);
  const availTok = Math.max(32, maxTokens - markerTok);
  const headTokBudget = Math.max(16, Math.floor(availTok * headRatio));
  const tailTokBudget = Math.max(16, availTok - headTokBudget);

  const lines = s.split('\n');
  if (lines.length >= 4) {
    const headLines = [];
    let hTok = 0;
    let hIdx = 0;
    while (hIdx < lines.length) {
      const lt = countTokens(lines[hIdx] + '\n');
      if (hTok + lt > headTokBudget && headLines.length) break;
      if (hTok + lt > headTokBudget) {
        headLines.push(lines[hIdx].slice(0, Math.max(32, headTokBudget * 3)));
        hIdx++;
        break;
      }
      headLines.push(lines[hIdx]);
      hTok += lt;
      hIdx++;
    }

    const tailLines = [];
    let tTok = 0;
    let tIdx = lines.length - 1;
    while (tIdx >= hIdx) {
      const lt = countTokens(lines[tIdx] + '\n');
      if (tTok + lt > tailTokBudget && tailLines.length) break;
      if (tTok + lt > tailTokBudget) {
        tailLines.unshift(lines[tIdx].slice(-Math.max(32, tailTokBudget * 3)));
        break;
      }
      tailLines.unshift(lines[tIdx]);
      tTok += lt;
      tIdx--;
    }

    return headLines.join('\n') + marker + tailLines.join('\n');
  }

  // Single-line / unstructured string fallback
  const charPerTok = s.length / Math.max(1, totalTok);
  const headChars = Math.max(32, Math.floor(headTokBudget * charPerTok * 0.9));
  const tailChars = Math.max(32, Math.floor(tailTokBudget * charPerTok * 0.9));
  return s.slice(0, headChars) + marker + s.slice(Math.max(headChars, s.length - tailChars));
}

// Estimates Anthropic ephemeral prompt cache token economics over N calls sharing a static
// prefix (cache write = 1.25x base input cost; cache read = 0.10x base input cost).
function estimatePromptCacheSavings({ uncachedTokens, cachedPrefixTokens, calls = 1 }) {
  const n = Math.max(1, Math.floor(Number(calls) || 1));
  const totalPerCall = Math.max(0, Number(uncachedTokens) || 0);
  const prefix = Math.min(totalPerCall, Math.max(0, Number(cachedPrefixTokens) || 0));
  const dynamic = totalPerCall - prefix;

  const uncachedTotalTokens = totalPerCall * n;
  // Minimum 1,024 tokens required by Anthropic for ephemeral caching to activate.
  if (prefix < 1024) {
    return {
      cacheable: false,
      uncachedTotalTokens,
      effectiveBilledTokens: uncachedTotalTokens,
      tokensSaved: 0,
      savingsRatio: 0,
      breakEvenCalls: null,
    };
  }

  const firstCallEffective = dynamic + Math.round(prefix * 1.25);
  const subsequentCallEffective = dynamic + Math.round(prefix * 0.10);
  const effectiveBilledTokens = firstCallEffective + Math.max(0, n - 1) * subsequentCallEffective;
  const tokensSaved = Math.max(0, uncachedTotalTokens - effectiveBilledTokens);
  return {
    cacheable: true,
    uncachedTotalTokens,
    effectiveBilledTokens,
    tokensSaved,
    savingsRatio: uncachedTotalTokens > 0 ? Number((tokensSaved / uncachedTotalTokens).toFixed(4)) : 0,
    breakEvenCalls: 2,
  };
}

module.exports = {
  countTokens,
  TOKENIZER_ID,
  chunkByTokenBudget,
  pruneContextWindow,
  estimatePromptCacheSavings,
};
