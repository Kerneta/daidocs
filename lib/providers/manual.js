// Provider for models reachable only through a chat UI. First run writes each prompt to
// results/manual-queue/<hash>.prompt.txt and marks it pending; paste replies back as
// <hash>.reply.txt, then re-run to pick them up. Latency is not scored here.

const fs = require('fs');
const path = require('path');
const { hash8, ensureDir } = require('../util');

function create(model = 'web-ui') {
  const qdir = path.join(__dirname, '..', '..', 'results', 'manual-queue');
  return {
    id: 'manual', model, live: true, noLatency: true,
    available: () => true,
    async complete({ system = '', prompt }) {
      const h = hash8(system + '\n' + prompt);
      const replyFp = path.join(qdir, `${h}.reply.txt`);
      if (fs.existsSync(replyFp)) return fs.readFileSync(replyFp, 'utf8');
      ensureDir(qdir);
      fs.writeFileSync(path.join(qdir, `${h}.prompt.txt`), (system ? `[SYSTEM]\n${system}\n\n[USER]\n` : '') + prompt, 'utf8');
      const err = new Error(`manual-pending:${h}`);
      err.manualPending = true;
      throw err;
    }
  };
}
module.exports = { create };
