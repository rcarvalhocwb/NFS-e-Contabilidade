const config = require('../config');
const db = require('../db');
const sessoes = require('../services/sessoes');
const { empresasDoUsuario } = require('../services/usuarios');

/**
 * Autenticação em três formas, do mais específico para o mais amplo:
 *
 *  - sessão de usuário (cookie): uma PESSOA operando o painel. Traz perfil
 *    (admin/operador) e a lista de empresas que enxerga. É o caminho normal.
 *
 *  - token de empresa (X-API-Key): credencial entregue a um sistema cliente.
 *    Vale para UMA empresa em UM ambiente — um token vazado não abre o grupo.
 *
 *  - chave global GATEWAY_API_KEY (X-API-Key): credencial de MÁQUINA, para
 *    chamadas de sistema e para criar o primeiro usuário na instalação. Não é
 *    login de pessoa: é a mesma para todos e não deixa rastro de quem agiu.
 *
 * O resultado fica em req.auth e é aplicado pelas rotas via middleware/escopo.
 */
module.exports = async function auth(req, res, next) {
  try {
    // 1. Sessão de usuário
    const token = sessoes.tokenDoPedido(req);
    if (token) {
      const usuario = await sessoes.usuarioDaSessao(token);
      if (usuario) {
        req.auth = {
          tipo: 'usuario',
          usuarioId: usuario.id,
          nome: usuario.nome,
          email: usuario.email,
          perfil: usuario.perfil,
          trocarSenha: usuario.trocar_senha,
          // null = todas as empresas
          empresasIds: await empresasDoUsuario(usuario.id)
        };
        return next();
      }
      // Cookie velho ou revogado: some com ele para não insistir a cada pedido
      sessoes.limparCookie(res);
    }

    const chave = req.header('X-API-Key');
    if (!config.apiKey) {
      return res.status(500).json({ erro: 'GATEWAY_API_KEY não configurada no servidor' });
    }
    if (!chave) {
      return res.status(401).json({ erro: 'Faça login no painel ou informe o header X-API-Key' });
    }

    // 2. Chave global: credencial de máquina, acesso irrestrito
    if (chave === config.apiKey) {
      req.auth = { tipo: 'maquina' };
      return next();
    }

    // 3. Token de empresa
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
