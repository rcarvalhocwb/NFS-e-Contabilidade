const config = require('../config');
const db = require('../db');

/**
 * Autenticação por X-API-Key, em dois níveis:
 *
 *  - chave global (GATEWAY_API_KEY): credencial administrativa. Acessa todas as
 *    empresas e as rotas de gestão (cadastro, certificados, municípios, painel).
 *
 *  - token de empresa: credencial entregue a cada sistema cliente. Vale para
 *    UMA empresa em UM ambiente. Com ele o cliente emite e consulta apenas as
 *    notas daquele CNPJ — sem isso, um token vazado daria acesso a todo o grupo.
 *
 * O escopo do token fica em req.auth e é aplicado pelas rotas.
 */
module.exports = async function auth(req, res, next) {
  const chave = req.header('X-API-Key');

  if (!config.apiKey) {
    return res.status(500).json({ erro: 'GATEWAY_API_KEY não configurada no servidor' });
  }
  if (!chave) {
    return res.status(401).json({ erro: 'Informe o header X-API-Key' });
  }

  // Credencial administrativa: acesso irrestrito.
  if (chave === config.apiKey) {
    req.auth = { tipo: 'admin' };
    return next();
  }

  // Token de empresa.
  try {
    const r = await db.query(
      `SELECT t.id, t.empresa_id, t.ambiente, e.cnpj, e.razao_social
         FROM empresa_tokens t
         JOIN empresas e ON e.id = t.empresa_id
        WHERE t.token = $1 AND t.ativo AND e.ativo`,
      [chave]
    );
    if (!r.rows.length) {
      return res.status(401).json({ erro: 'API key inválida' });
    }
    const t = r.rows[0];
    req.auth = {
      tipo: 'empresa',
      empresaId: t.empresa_id,
      cnpj: t.cnpj,
      razaoSocial: t.razao_social,
      ambiente: t.ambiente
    };

    // Registro de uso: útil para saber se um token está em uso antes de
    // revogá-lo. Sem await, para não somar latência a cada requisição.
    db.query('UPDATE empresa_tokens SET ultimo_uso = now() WHERE id = $1', [t.id])
      .catch(e => console.error('[auth] falha ao registrar uso do token:', e.message));

    return next();
  } catch (e) {
    return next(e);
  }
};
