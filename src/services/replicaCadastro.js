const crypto = require('crypto');
const db = require('../db');
const { decrypt } = require('../secretbox');

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
 *        Corpo: { versao, geradoEm, empresas[], servicos[], acessos[], whatsapp[] }
 *        Responde 200 com { ok: true } depois de aplicar o retrato inteiro.
 */

async function montar() {
  const empresas = await db.query(
    `SELECT e.cnpj, e.razao_social, e.nome_fantasia, e.codigo_municipio, e.uf,
            e.modo_emissao, e.portal_liberado, e.portal_motivo, e.ativo,
            -- O NOME da cidade, não só o código. A conversa oferece ao cliente
            -- escolher onde o serviço foi prestado, e "4106902" não é uma opção
            -- que alguém reconheça: "Curitiba" é.
            m.nome AS municipio_nome
       FROM empresas e
       LEFT JOIN municipios m ON m.codigo_municipio = e.codigo_municipio
      ORDER BY e.cnpj`);

  /* Os serviços que o contador cadastrou. É deles que o cliente escolhe — e é
     por isso que ele não precisa (nem pode) escolher tributação: o código, a
     alíquota e a retenção vêm prontos daqui. */
  const servicos = await db.query(
    `SELECT s.id, e.cnpj, s.apelido, s.descricao, s.codigo_tributacao,
            s.valor_padrao, s.aliquota_iss, s.iss_retido, s.ativo
       FROM servicos s JOIN empresas e ON e.id = s.empresa_id
      WHERE s.ativo ORDER BY e.cnpj, s.apelido`);

  /* A ultima nota de cada empresa, para o "a nota de sempre" funcionar do
     outro lado desde a primeira mensagem. So o suficiente para montar o
     pedido de novo: quem, o que, quanto. Sem chave, sem XML, sem PDF. */
  const ultimas = await db.query(
    `SELECT DISTINCT ON (n.empresa_id)
            e.cnpj, n.dps_xml
       FROM notas n JOIN empresas e ON e.id = n.empresa_id
      WHERE n.status = 'autorizada' AND n.dps_xml IS NOT NULL
      ORDER BY n.empresa_id, n.id DESC`);

  const acessos = await db.query(
    `SELECT u.email, u.nome, u.cliente_cargo, u.ativo,
            COALESCE(array_agg(e.cnpj ORDER BY e.cnpj)
                     FILTER (WHERE e.cnpj IS NOT NULL), '{}') AS empresas
       FROM usuarios u
       LEFT JOIN usuario_empresas ue ON ue.usuario_id = u.id
       LEFT JOIN empresas e ON e.id = ue.empresa_id
      WHERE u.perfil = 'cliente'
      GROUP BY u.id ORDER BY u.email`);

  /* O pedido anterior de cada empresa, extraído da DPS. Vai sem chave de
     acesso e sem XML: serve para repetir, não para consultar. */
  const anteriores = {};
  for (const linha of ultimas.rows) {
    const x = linha.dps_xml;
    const pega = t => (x.match(new RegExp('<' + t + '>([^<]*)</' + t + '>')) || [])[1] || null;
    const bloco = (x.match(/<toma>([\s\S]*?)<\/toma>/) || [])[1] || '';
    const doToma = t => (bloco.match(new RegExp('<' + t + '>([^<]*)</' + t + '>')) || [])[1] || null;
    const doc = doToma('CNPJ') || doToma('CPF');
    if (!doc) continue;
    anteriores[linha.cnpj] = {
      tomador: { documento: doc, nome: doToma('xNome') },
      servico: {
        codigoTributacao: pega('cTribNac'),
        descricao: pega('xDescServ')
      },
      valor: pega('vServ') ? Number(pega('vServ')) : null
    };
  }

  /* Quem pode pedir nota pelo WhatsApp, e por qual CNPJ.
     Vai o número e o teto, nada mais — o relay precisa saber de quem é a
     mensagem que chegou, não quem a pessoa é. */
  const whats = await db.query(
    `SELECT c.telefone, c.nome, c.limite_valor, e.cnpj
       FROM contatos_whatsapp c JOIN empresas e ON e.id = c.empresa_id
      WHERE c.ativo AND e.ativo ORDER BY c.telefone`);

  /* As credenciais do número do escritório viajam com o cadastro, para o
     contador não precisar editar arquivo num servidor. App Secret e token de
     verificação NÃO vêm aqui: são eles que protegem este canal, e mandá-los
     por ele fecharia o círculo. */
  const cfg = await db.query(
    `SELECT wa_numero, wa_phone_number_id, wa_ativo, wa_token_cifrado
       FROM config_nuvem WHERE id = TRUE`);
  const c = cfg.rows[0] || {};
  let waToken = null;
  if (c.wa_token_cifrado) {
    try { waToken = decrypt(c.wa_token_cifrado).toString('utf8'); }
    catch (_) { waToken = null; }
  }

  /* Quem está falando com o cliente.
     Do outro lado é uma janela de WhatsApp: sem isso, a primeira mensagem vem
     de um número desconhecido dizendo o nome da empresa DELE, e a pessoa não
     sabe se está falando com a contabilidade ou com um golpe. */
  const ident = await db.query(
    `SELECT nome, descricao, telefone, email FROM identidade LIMIT 1`);
  const id = ident.rows[0] || {};

  /* E COM QUE PALAVRAS. Nulo aqui é resposta legítima: significa "use o texto
     padrão", e quem sabe qual é o padrão é o repassador. Mandar o padrão daqui
     seria mantê-lo em dois lugares, que é o mesmo que mantê-lo em nenhum. */
  const bot = await db.query(
    `SELECT saudacao, atendente, horario FROM chatbot WHERE id = TRUE`)
    .catch(() => ({ rows: [] }));
  const b = bot.rows[0] || {};

  const retrato = {
    geradoEm: new Date().toISOString(),
    escritorio: {
      nome: id.nome || null,
      descricao: id.descricao || null,
      telefone: id.telefone || null,
      email: id.email || null
    },
    chatbot: {
      saudacao: b.saudacao || null,
      atendente: b.atendente || null,
      horario: b.horario || null
    },
    canal: {
      numero: c.wa_numero || null,
      phoneNumberId: c.wa_phone_number_id || null,
      token: waToken,
      ativo: !!c.wa_ativo
    },
    whatsapp: whats.rows.map(w => ({
      telefone: w.telefone,
      cnpj: w.cnpj,
      nome: w.nome,
      limiteValor: w.limite_valor === null ? null : Number(w.limite_valor)
    })),
    empresas: empresas.rows.map(e => ({
      cnpj: e.cnpj,
      razaoSocial: e.razao_social,
      nomeFantasia: e.nome_fantasia,
      codigoMunicipio: e.codigo_municipio,
      municipio: e.municipio_nome || null,
      uf: e.uf,
      modoEmissao: e.modo_emissao,
      ativo: e.ativo,
      // O portal esconde o botão; o gateway continua conferindo na chegada.
      liberado: e.portal_liberado,
      // O "de sempre" daquela empresa, quando existe
      ultimoPedido: anteriores[e.cnpj] || null,
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
