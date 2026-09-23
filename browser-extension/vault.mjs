#!/usr/bin/env node
// Vault CLI: manage the encrypted browse-history vault.
//
//   node vault.mjs init   --password <pw>          create the vault keypair
//   node vault.mjs status                          counts and dates, no content
//   node vault.mjs unlock --password <pw>          decrypt into _vault_open/
//   node vault.mjs lock                            delete the plaintext view
//
// The flow for an LLM session: the user gives the assistant the password, the
// assistant runs unlock, reads the files under _vault_open/, then runs lock.
// Without unlock everything under _vault/ is ciphertext.
//
// Env: DAIDOCS_STORE   store location (default ~/DaiDocs)
//
// No em dashes in this file, per project rule.

import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const vault = require('./lib/vault_core');

const STORE_DIR = path.resolve(process.env.DAIDOCS_STORE || path.join(os.homedir(), 'DaiDocs'));

function arg(name) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 ? process.argv[i + 1] : null;
}

const cmd = process.argv[2];

try {
  if (cmd === 'init') {
    const pw = arg('password');
    if (!pw) throw new Error('usage: node vault.mjs init --password <pw>  (8+ characters)');
    vault.init(STORE_DIR, pw);
    console.log('Vault initialized at', path.join(STORE_DIR, '_vault'));
    console.log('The password is NOT stored anywhere. If it is lost, vault contents are unrecoverable.');
  } else if (cmd === 'status') {
    console.log(JSON.stringify(vault.status(STORE_DIR), null, 2));
  } else if (cmd === 'unlock') {
    const pw = arg('password');
    if (!pw) throw new Error('usage: node vault.mjs unlock --password <pw>');
    const r = vault.unlock(STORE_DIR, pw);
    console.log(`Unlocked ${r.entries} entries into ${r.dir}`);
    console.log('Run "node vault.mjs lock" when done: the plaintext view is deleted then.');
  } else if (cmd === 'lock') {
    vault.lock(STORE_DIR);
    console.log('Locked: plaintext view deleted.');
  } else {
    console.log('usage: node vault.mjs <init|status|unlock|lock> [--password <pw>]');
    process.exit(cmd ? 1 : 0);
  }
} catch (e) {
  console.error('vault error:', e.message);
  process.exit(1);
}
