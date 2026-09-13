// Redacts credentials from anything entering the store, so a pasted key can't sit in
// _raw forever, get indexed, or reach the observer. Anchored on issuer prefixes, not
// entropy, so real content (base64, hashes, minified code) is never eaten.

const PATTERNS = [
  // Anthropic before OpenAI: the sk- form matches sk-ant- too, so order keeps the
  // label right (both redact either way, but a wrong label rotates the wrong key).
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
  // A key in an obviously-named quoted variable. Last and narrow: needs the name to say
  // key/token/secret AND a long quoted value.
  [/\b([A-Z_]*(?:API_KEY|ACCESS_TOKEN|SECRET_KEY|AUTH_TOKEN))\s*[:=]\s*["'][^"']{16,}["']/g, 'NAMED_SECRET'],
];

// Returns { text, found } where found is a count per kind, empty if clean.
function redact(input) {
  let text = String(input == null ? '' : input);
  const found = {};
  for (const [re, label] of PATTERNS) {
    text = text.replace(re, (match) => {
      found[label] = (found[label] || 0) + 1;
      // Keep the issuer prefix plus a short fingerprint so two keys stay
      // distinguishable without being recoverable.
      const head = match.slice(0, 7).replace(/\s+/g, ' ');
      return `[${label} REDACTED ${head}...]`;
    });
  }
  return { text, found };
}

const summarize = found => Object.entries(found).map(([k, n]) => `${n} ${k}`).join(', ');

module.exports = { redact, summarize, PATTERNS };
