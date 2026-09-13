// Local-model provider via Ollama (http://localhost:11434). Free, private, and the
// right backend for `sensitivity: secret` corpora that must never leave the machine.
//
// Uses node:http, not fetch: undici's 300s header timeout kills CPU-speed
// generations (a single ingest can run >5 min); stream:false replies only when done.
const http = require('http');

function post(base, path, bodyObj) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(bodyObj));
    const u = new URL(base);
    const req = http.request(
      { hostname: u.hostname, port: u.port || 11434, path, method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': data.length } },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      }
    );
    req.on('error', reject);
    // no timeout: local models take as long as they take
    req.end(data);
  });
}

function create(model = 'llama3.1') {
  const base = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
  return {
    id: 'ollama', model, live: true,
    // no key needed; a dead daemon surfaces as a normal error from complete()
    available: () => true,
    async complete({ system = '', prompt, maxTokens = 2048, format }) {
      const res = await post(base, '/api/generate', {
        model, system, prompt, stream: false,
        // format:'json' constrains decoding; small models otherwise ramble past the budget
        ...(format ? { format } : {}),
        keep_alive: process.env.OLLAMA_KEEP_ALIVE || '30m',
        // Ollama defaults num_ctx to 4096 but DaiDocs contexts reach ~8k; 16k is safe.
        // OLLAMA_PREDICT_BOOST adds headroom since num_predict counts <think> tokens.
        options: { num_predict: maxTokens + Number(process.env.OLLAMA_PREDICT_BOOST || 0), num_ctx: Number(process.env.OLLAMA_NUM_CTX || 16384) },
        // thinking control for qwen3/deepseek-r1; OLLAMA_THINK=false stops <think> budget burn
        ...(process.env.OLLAMA_THINK ? { think: process.env.OLLAMA_THINK === 'true' } : {})
      });
      if (res.status !== 200) throw new Error(`ollama ${res.status}: ${res.text.slice(0, 300)}`);
      return JSON.parse(res.text).response || '';
    }
  };
}
module.exports = { create };
