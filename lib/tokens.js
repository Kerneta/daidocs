// Token counting. Primary: gpt-tokenizer (offline); fallback: a chars/4-plus-words
// estimator so a machine without node_modules still works. The counter used is
// recorded per result row; mixed-counter comparisons are invalid.

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

module.exports = { countTokens, TOKENIZER_ID };
