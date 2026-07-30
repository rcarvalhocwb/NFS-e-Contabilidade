const db = require('../db');
const secretbox = require('../secretbox');
const { lerPfx } = require('../cert/certificado');

/* Salva (criptografado) um novo certificado da empresa e desativa os anteriores. */
async function salvarCertificado(empresaId, pfxBuffer, senha) {
  const info = lerPfx(pfxBuffer, senha); // valida senha e extrai metadados

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE certificados SET ativo = FALSE WHERE empresa_id = $1', [empresaId]);
    const r = await client.query(
      `INSERT INTO certificados (empresa_id, pfx_cifrado, senha_cifrada, subject, cnpj_cert, valido_ate)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, subject, cnpj_cert, valido_ate`,
      [
        empresaId,
        secretbox.encrypt(pfxBuffer),
        secretbox.encrypt(Buffer.from(senha, 'utf8')),
        info.subject,
        info.cnpj,
        info.validoAte
      ]
    );
    await client.query('COMMIT');
    return r.rows[0];
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/* Carrega o certificado ativo da empresa, já decifrado e pronto para uso. */
async function carregarCertificadoAtivo(empresaId) {
  const r = await db.query(
    `SELECT * FROM certificados
     WHERE empresa_id = $1 AND ativo ORDER BY criado_em DESC LIMIT 1`,
    [empresaId]
  );
  if (!r.rows.length) throw Object.assign(new Error('Empresa sem certificado ativo'), { status: 422 });

  const row = r.rows[0];
  if (row.valido_ate && new Date(row.valido_ate) < new Date()) {
    throw Object.assign(new Error(`Certificado vencido em ${new Date(row.valido_ate).toISOString()}`), { status: 422 });
  }

  const pfx = secretbox.decrypt(row.pfx_cifrado);
  const senha = secretbox.decrypt(row.senha_cifrada).toString('utf8');
  const info = lerPfx(pfx, senha);

  // keyPem/certPem são o que vai para o TLS: o OpenSSL 3 (Node 20+) recusa
  // PKCS#12 com criptografia legada (RC2/3DES), padrão dos certificados A1
  // brasileiros, com "Unsupported PKCS12 PFX data". O node-forge lê o .pfx em
  // JS puro e extrai chave e certificado, que o OpenSSL aceita normalmente.
  // pfx/senha seguem expostos para quem precise do arquivo original.
  return {
    pfx, senha,
    keyPem: info.keyPem,
    certPem: info.certPem,
    certDerB64: info.certDerB64
  };
}

module.exports = { salvarCertificado, carregarCertificadoAtivo };
