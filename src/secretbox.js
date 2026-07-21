/* Criptografia AES-256-GCM para armazenar certificados e senhas no banco. */
const crypto = require('crypto');
const config = require('./config');

function key() {
  if (!config.masterKey || config.masterKey.length !== 64) {
    throw new Error('MASTER_KEY inválida: defina 32 bytes em hex (64 caracteres) no .env');
  }
  return Buffer.from(config.masterKey, 'hex');
}

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]); // 12 iv + 16 tag + dados
}

function decrypt(blob) {
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

module.exports = { encrypt, decrypt };
