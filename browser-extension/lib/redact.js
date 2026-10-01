// Secret redaction for anything on its way into the store.
//
// The archiver's promise is that a session is preserved losslessly. That
// promise, applied to a conversation where someone pasted an API key, turns the
// memory store into a secret store: the key sits in plain text in _raw forever,
// gets indexed, and is sent to the observer API as document content on ingest.
//
// So losslessness is deliberately broken for credentials and nothing else. A
// redacted key is not information anyone wants back, and the alternative is a
// plain-text credential on disk with an unbounded lifetime.
//
// Patterns are anchored on issuer prefixes rather than entropy heuristics.
// Entropy scoring flags base64 payloads, hashes and minified code, and a
// redactor that eats real content is one people turn off.

const PATTERNS = [
  // Anthropic FIRST: the generic OpenAI sk- form below also matches sk-ant-,
  // so ordering is what keeps the label honest. Both redact either way, but a
  // wrong label sends someone to rotate the wrong key.
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/g, 'ANTHROPIC_KEY'],
  // OpenAI: sk-..., sk-proj-..., and the org/service variants
  [/\bsk-(?!ant-)(?:proj|svcacct|admin)?-?[A-Za-z0-9_-]{20,}/g, 'OPENAI_KEY'],
  // Google / Gemini
  [/\bAIza[A-Za-z0-9_-]{30,}/g, 'GOOGLE_KEY'],
  // GitHub tokens, classic and fine-grained
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/g, 'GITHUB_TOKEN'],
  [/\bgithub_pat_[A-Za-z0-9_]{50,}/g, 'GITHUB_TOKEN'],
  // AWS access key id, and a secret only when it is labelled as one
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, 'AWS_KEY_ID'],
  [/\baws_secret_access_key\s*[:=]\s*\S+/gi, 'AWS_SECRET'],
  // Slack
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, 'SLACK_TOKEN'],
  // OpenRouter, Groq, Together and friends all use sk- forms caught above.
  // Private keys, whole block
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, 'PRIVATE_KEY'],
  // Bearer tokens in pasted headers
  [/\bBearer\s+[A-Za-z0-9._-]{20,}/g, 'BEARER_TOKEN'],
  // A key assigned to an obviously-named variable, when the value is quoted.
  // Deliberately last, and deliberately narrow: it requires the name to say
  // key/token/secret AND the value to be quoted and long.
  [/\b([A-Z_]*(?:API_KEY|ACCESS_TOKEN|SECRET_KEY|AUTH_TOKEN))\s*[:=]\s*["'][^"']{16,}["']/g, 'NAMED_SECRET'],
];

// Returns { text, found } where found is a count per kind, empty if clean.
function redact(input) {
  let text = String(input == null ? '' : input);
  const found = {};
  for (const [re, label] of PATTERNS) {
    text = text.replace(re, (match) => {
      found[label] = (found[label] || 0) + 1;
      // Keep the issuer prefix so the text still reads sensibly, and keep a
      // short fingerprint so two different keys stay distinguishable without
      // being recoverable.
      const head = match.slice(0, 7).replace(/\s+/g, ' ');
      return `[${label} REDACTED ${head}...]`;
    });
  }
  return { text, found };
}

const summarize = found => Object.entries(found).map(([k, n]) => `${n} ${k}`).join(', ');

module.exports = { redact, summarize, PATTERNS };
