// Vault core: encryption for the browse-history vault.
//
// Design goal: the capture server must be able to ENCRYPT while never holding
// the password. So the vault is hybrid:
//   init      makes an RSA-3072 keypair. The PUBLIC key is stored plaintext;
//             the PRIVATE key is stored encrypted with a key derived from the
//             vault password (scrypt, per-vault salt). The password itself is
//             never stored anywhere.
//   encrypt   fresh AES-256-GCM key per entry file, wrapped with the public
//             key (RSA-OAEP/SHA-256). Server-side, passwordless.
//   unlock    password -> scrypt -> decrypt private key -> unwrap AES keys ->
//             plaintext. Only ever happens on explicit request with the
//             password supplied.
//
// A wrong password fails loudly at private-key decryption (GCM auth tag), so
// no separate verifier value is needed and none is stored.
//
// No em dashes in this file, per project rule.

'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function vaultDir(storeDir) { return path.join(storeDir, '_vault'); }
function vaultConfigPath(storeDir) { return path.join(vaultDir(storeDir), 'vault.json'); }
function openDir(storeDir) { return path.join(storeDir, '_vault_open'); }

function isInitialized(storeDir) { return fs.existsSync(vaultConfigPath(storeDir)); }

function deriveKey(password, saltB64) {
  return crypto.scryptSync(String(password), Buffer.from(saltB64, 'base64'), 32, SCRYPT);
}

function init(storeDir, password) {
  if (isInitialized(storeDir)) throw new Error('vault already initialized');
  if (!password || String(password).length < 8) throw new Error('password must be at least 8 characters');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 3072,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(password), salt, 32, SCRYPT);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(privateKey, 'utf8'), cipher.final()]);
  fs.mkdirSync(vaultDir(storeDir), { recursive: true });
  fs.writeFileSync(vaultConfigPath(storeDir), JSON.stringify({
    v: 1, created: new Date().toISOString(),
    kdf: { alg: 'scrypt', N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: salt.toString('base64') },
    publicKey,
    privateKeyEnc: { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: enc.toString('base64') },
  }, null, 2));
  return { ok: true };
}

function loadConfig(storeDir) {
  if (!isInitialized(storeDir)) throw new Error('vault not initialized: run vault init first');
  return JSON.parse(fs.readFileSync(vaultConfigPath(storeDir), 'utf8'));
}

// Encrypt a UTF-8 string into one .enc envelope. Passwordless (public key).
function encryptBlob(storeDir, plaintext) {
  const cfg = loadConfig(storeDir);
  const aesKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
  const data = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const wrapped = crypto.publicEncrypt(
    { key: cfg.publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    aesKey
  );
  return JSON.stringify({
    v: 1, alg: 'aes-256-gcm+rsa-oaep-3072',
    key: wrapped.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  });
}

function privateKeyFromPassword(storeDir, password) {
  const cfg = loadConfig(storeDir);
  const key = deriveKey(password, cfg.kdf.salt);
  const d = cfg.privateKeyEnc;
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(d.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(d.tag, 'base64'));
  try {
    return Buffer.concat([decipher.update(Buffer.from(d.data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('wrong password');
  }
}

function decryptBlob(privateKeyPem, envelopeJson) {
  const env = JSON.parse(envelopeJson);
  const aesKey = crypto.privateDecrypt(
    { key: privateKeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(env.key, 'base64')
  );
  const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, Buffer.from(env.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(env.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(env.data, 'base64')), decipher.final()]).toString('utf8');
}

// Write one encrypted entry file into a vault subfolder. Browse history gets
// its own folder type per kind and is never mixed with chat history.
function writeEncrypted(storeDir, subdir, baseName, plaintext) {
  const dir = path.join(vaultDir(storeDir), subdir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, baseName + '.enc');
  fs.writeFileSync(file, encryptBlob(storeDir, plaintext));
  // Mark read-only: a deterrent against casual edit/delete in a file manager.
  // Not absolute (the owner can clear it), but combined with encryption it means
  // the files cannot be read or quietly changed without the vault password.
  try { fs.chmodSync(file, 0o444); } catch {}
  return file;
}

// Plaintext-free stats for dashboards and status: counts and dates only.
function status(storeDir) {
  const out = { initialized: isInitialized(storeDir), folders: {}, unlocked: fs.existsSync(openDir(storeDir)) };
  if (!out.initialized) return out;
  const root = vaultDir(storeDir);
  for (const d of fs.readdirSync(root)) {
    const p = path.join(root, d);
    if (!fs.statSync(p).isDirectory()) continue;
    const files = fs.readdirSync(p).filter(f => f.endsWith('.enc'));
    out.folders[d] = { entries: files.length, latest: files.sort().slice(-1)[0] || null };
  }
  return out;
}

// Decrypt every vault file IN MEMORY and return it, writing nothing to disk.
// This is what the browser viewer uses: originals are shown but never left as
// plaintext on the drive. Throws 'wrong password' on a bad password, and a
// per-file decrypt failure is surfaced as a tamper flag rather than aborting.
function readAll(storeDir, password) {
  const pk = privateKeyFromPassword(storeDir, password);   // throws on wrong password
  const root = vaultDir(storeDir);
  const files = [];
  for (const d of fs.readdirSync(root)) {
    const p = path.join(root, d);
    if (!fs.statSync(p).isDirectory()) continue;
    for (const f of fs.readdirSync(p).sort()) {
      if (!f.endsWith('.enc')) continue;
      let text = null, tampered = false;
      try { text = decryptBlob(pk, fs.readFileSync(path.join(p, f), 'utf8')); }
      catch { tampered = true; }              // GCM auth failure means the file was altered
      files.push({ folder: d, name: f.replace(/\.enc$/, ''), tampered, text });
    }
  }
  return { ok: true, files };
}

function unlock(storeDir, password) {
  const pk = privateKeyFromPassword(storeDir, password);   // throws on wrong password
  const root = vaultDir(storeDir);
  const out = openDir(storeDir);
  let n = 0;
  for (const d of fs.readdirSync(root)) {
    const p = path.join(root, d);
    if (!fs.statSync(p).isDirectory()) continue;
    for (const f of fs.readdirSync(p)) {
      if (!f.endsWith('.enc')) continue;
      const plain = decryptBlob(pk, fs.readFileSync(path.join(p, f), 'utf8'));
      const destDir = path.join(out, d);
      fs.mkdirSync(destDir, { recursive: true });
      fs.writeFileSync(path.join(destDir, f.replace(/\.enc$/, '')), plain);
      n++;
    }
  }
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'OPENED.json'), JSON.stringify({ at: new Date().toISOString(), entries: n }));
  return { ok: true, entries: n, dir: out };
}

// Check a password without decrypting anything to disk: try to unwrap the
// private key; success means the password is right.
function verify(storeDir, password) {
  if (!isInitialized(storeDir)) return false;
  try { privateKeyFromPassword(storeDir, password); return true; } catch { return false; }
}

function lock(storeDir) {
  const out = openDir(storeDir);
  if (fs.existsSync(out)) fs.rmSync(out, { recursive: true, force: true });
  return { ok: true };
}

module.exports = { isInitialized, init, encryptBlob, writeEncrypted, status, unlock, lock, verify, readAll, openDir, vaultDir };
