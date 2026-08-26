const crypto = require('crypto');
const db = require('../db');

/* Réplica do cadastro para o portal.
 *
 * O escritório é a fonte de verdade: empresas, serviços e quem pode acessar
 * cada CNPJ são escritos aqui, no gateway, onde o contador já trabalha. O
 * portal recebe um retrato e não escreve nada de volta. Um sentido só — dois
 * seriam duas verdades, e a pergunta "quem tem acesso à empresa X?" passaria a
 * ter duas respostas possíveis.
 *
 * RETRATO INTEIRO, NÃO FLUXO DE DIFERENÇAS. Um cadastro completo a cada envio
 * é maior, e em troca se conserta sozinho: se o portal perder um envio, ficar
 * fora do ar por um dia ou for restaurado de um backup velho, o próximo retrato
 * corrige tudo. Fila de diferenças, não — ela só volta ao normal se ninguém
 * perder nada, e alguém sempre perde.
 *
 * O QUE NUNCA VAI JUNTO: certificado, senha, hash de senha, token de empresa.
 * O portal precisa saber quem pode entrar e o que a pessoa vê; o segredo que
 * prova a identidade dela é dele, definido lá pelo convite. Assim uma invasão
 * do portal não expõe credencial do escritório.
 *
 * O QUE O PORTAL PRECISA OFERECER:
 *
 *   POST {url}/cadastro
 *        Cabeçalho: Authorization: Bearer {chave}
 *        Corpo: { versao, geradoEm, empresas[], servicos[], acessos[] }
 *        Responde 200 com { ok: true } depois de aplicar o retrato inteiro.
 */

async function montar() {
  const empresas = await db.query(
    `SELECT cnpj, razao_social, nome_fantasia, codigo_municipio, uf,
            modo_emissao, portal_liberado, portal_motivo, ativo
       FROM empresas ORDER BY cnpj`);

  /* Os serviços que o contador cadastrou. É deles que o cliente escolhe — e é
     por isso que ele não precisa (nem pode) escolher tributação: o código, a
     alíquota e a retenção vêm prontos daqui. */
  const servicos = await db.query(
    `SELECT s.id, e.cnpj, s.apelido, s.descricao, s.codigo_tributacao,
            s.valor_padrao, s.aliquota_iss, s.iss_retido, s.ativo
       FROM servicos s JOIN empresas e ON e.id = s.empresa_id
      WHERE s.ativo ORDER BY e.cnpj, s.apelido`);

  const acessos = await db.query(
    `SELECT u.email, u.nome, u.cliente_cargo, u.ativo,
            COALESCE(array_agg(e.cnpj ORDER BY e.cnpj)
                     FILTER (WHERE e.cnpj IS NOT NULL), '{}') AS empresas
       FROM usuarios u
       LEFT JOIN usuario_empresas ue ON ue.usuario_id = u.id
       LEFT JOIN empresas e ON e.id = ue.empresa_id
      WHERE u.perfil = 'cliente'
      GROUP BY u.id ORDER BY u.email`);

  const retrato = {
    geradoEm: new Date().toISOString(),
    empresas: empresas.rows.map(e => ({
      cnpj: e.cnpj,
      razaoSocial: e.razao_social,
      nomeFantasia: e.nome_fantasia,
      codigoMunicipio: e.codigo_municipio,
      uf: e.uf,
      modoEmissao: e.modo_emissao,
      ativo: e.ativo,
      // O portal esconde o botão; o gateway continua conferindo na chegada.
      liberado: e.portal_liberado,
      /* Bloqueio sempre viaja com texto. Sem ele o cliente lê "bloqueado" e não
         sabe o que fazer — e é o mesmo padrão que a conferência na chegada usa,
         para a tela dele e a recusa dizerem a mesma coisa. */
      motivoBloqueio: e.portal_liberado ? null
        : (e.portal_motivo ||
           'A contabilidade ainda não liberou a emissão pelo portal para esta empresa.')
    })),
    servicos: servicos.rows.map(s => ({
      id: s.id,
      cnpj: s.cnpj,
      apelido: s.apelido,
      descricao: s.descricao,
      codigoTributacao: s.codigo_tributacao,
      valorPadrao: s.valor_padrao == null ? null : Number(s.valor_padrao),
      aliquotaIss: s.aliquota_iss == null ? null : Number(s.aliquota_iss),
      issRetido: s.iss_retido
    })),
    acessos: acessos.rows.map(u => ({
      email: u.email,
      nome: u.nome,
      cargo: u.cliente_cargo,
      ativo: u.ativo,
      empresas: u.empresas
    }))
  };

  /* A impressão digital ignora o geradoEm: senão todo retrato seria "novo" e o
     gateway ficaria reenviando o cadastro inteiro a cada rodada. */
  const semData = Object.assign({}, retrato);
  delete semData.geradoEm;
  retrato.versao = crypto.createHash('sha256')
    .update(JSON.stringify(semData)).digest('hex');

  return retrato;
}

/* Manda o retrato se ele mudou desde o último envio aceito.
   `forcar` reenvia mesmo sem mudança — serve para o botão "Enviar agora", e
   para depois de o portal ser restaurado de um backup. */
async function enviar({ forcar = false } = {}) {
  const ponte = require('./ponteNuvem');
  const c = await ponte.ler();
  if (!c.url) return { pulado: 'portal não configurado' };

  const retrato = await montar();
  if (!forcar && c.cadastro_hash === retrato.versao) {
    return { pulado: 'cadastro sem alteração', versao: retrato.versao };
  }

  try {
    const r = await ponte.chamar('/cadastro', {
      method: 'POST', body: JSON.stringify(retrato)
    });
    if (r.status < 200 || r.status >= 300) {
      throw new Error('o portal respondeu HTTP ' + r.status);
    }
    await db.query(
      `UPDATE config_nuvem SET cadastro_hash = $1, cadastro_em = now(),
              cadastro_erro = NULL WHERE id = TRUE`, [retrato.versao]);
    return {
      versao: retrato.versao,
      empresas: retrato.empresas.length,
      servicos: retrato.servicos.length,
      acessos: retrato.acessos.length
    };
  } catch (e) {
    await db.query(
      'UPDATE config_nuvem SET cadastro_erro = $1 WHERE id = TRUE', [e.message]);
    throw Object.assign(e, { status: e.status || 502 });
  }
}

module.exports = { montar, enviar };
