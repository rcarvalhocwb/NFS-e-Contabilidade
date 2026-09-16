/* O que cada cliente pediu, e o que aconteceu com o pedido.
 *
 * POR QUE AGRUPAR POR PESSOA E NÃO POR PEDIDO: a fila responde "o que preciso
 * aprovar agora". Ela não responde "o que essa pessoa vem pedindo", que é a
 * pergunta de quando o cliente liga reclamando — e a de quando alguém precisa
 * mostrar, no dia da dúvida, que a nota foi pedida por quem diz não ter pedido.
 *
 * TRÊS LEITURAS DO MESMO FATO. O mesmo pedido é uma coisa diferente para cada
 * lado, e as três precisam sair da MESMA linha do tempo — senão viram três
 * relatórios que divergem:
 *
 *   cliente   o que ele digitou e o que recebeu de volta. É o que ele vai ler
 *             em voz alta ao telefone quando discordar de alguma coisa.
 *   emissor   o que o sistema montou com aquilo: CNPJ, serviço, valor,
 *             endereço. É onde se vê se a conversa entendeu o que foi dito.
 *   contador  quem liberou, quando, e o que a Sefin devolveu. É a
 *             responsabilidade — e é o que uma fiscalização pergunta.
 *
 * Nada aqui inventa dado: tudo vem de `solicitacoes`, `notas` e `auditoria`,
 * que já existiam. O que faltava era a costura.
 */
const db = require('../db');

/* O telefone chega de vários jeitos (com 55, sem 55, com o nono dígito, sem).
   Compara-se pelos últimos oito, que é o que não muda em nenhuma variação —
   mesma regra que `contatosWhatsapp` usa para reconhecer quem está falando. */
function sufixo(telefone) {
  const so = String(telefone || '').replace(/\D/g, '');
  return so.slice(-8);
}

/* ------------------------------------------------------- quem já falou */

async function listar({ empresasVisiveis = null } = {}) {
  const params = [];
  let filtro = '';
  if (empresasVisiveis !== null) {
    params.push(empresasVisiveis);
    filtro = ` AND s.empresa_id = ANY($${params.length}::int[])`;
  }

  const r = await db.query(
    `SELECT s.remetente,
            count(*)::int                                   AS pedidos,
            count(*) FILTER (WHERE s.situacao = 'aguardando')::int AS aguardando,
            count(*) FILTER (WHERE s.situacao = 'emitida')::int    AS emitidas,
            count(*) FILTER (WHERE s.situacao = 'recusada')::int   AS recusadas,
            max(s.recebida_em)                              AS ultima_em,
            array_agg(DISTINCT e.razao_social) FILTER (WHERE e.razao_social IS NOT NULL)
                                                            AS empresas
       FROM solicitacoes s
       LEFT JOIN empresas e ON e.id = s.empresa_id
      WHERE s.remetente IS NOT NULL${filtro}
      GROUP BY s.remetente
      ORDER BY max(s.recebida_em) DESC
      LIMIT 200`, params);

  /* O nome de quem fala vem do cadastro de autorizados, não do pedido: é o
     nome que o escritório digitou, e é por ele que a pessoa é conhecida ali. */
  const contatos = await db.query(
    `SELECT c.telefone, c.nome, c.cargo, e.razao_social
       FROM contatos_whatsapp c
       LEFT JOIN empresas e ON e.id = c.empresa_id`);

  return r.rows.map(linha => {
    const s = sufixo(linha.remetente);
    const dono = contatos.rows.find(c => sufixo(c.telefone) === s);
    return Object.assign({}, linha, {
      nome: dono ? dono.nome : null,
      cargo: dono ? dono.cargo : null,
      autorizado: !!dono
    });
  });
}

/* ------------------------------------------- a história de uma pessoa */

async function historico(telefone, { empresasVisiveis = null } = {}) {
  const s = sufixo(telefone);
  if (s.length < 8) {
    throw Object.assign(new Error('Telefone inválido.'), { status: 400 });
  }

  const params = [s];
  let filtro = '';
  if (empresasVisiveis !== null) {
    params.push(empresasVisiveis);
    filtro = ` AND s.empresa_id = ANY($${params.length}::int[])`;
  }

  const pedidos = await db.query(
    `SELECT s.id, s.id_externo, s.situacao, s.motivo, s.origem, s.remetente,
            s.recebida_em, s.decidido_por, s.decidido_em, s.devolvida_em,
            s.payload, s.transcricao, s.cnpj_informado,
            e.razao_social AS empresa, e.cnpj AS empresa_cnpj,
            -- O valor sai do PEDIDO, nao da nota: notas guarda o XML, e ler
            -- valor de dentro de XML a cada linha de listagem seria caro para
            -- mostrar um numero que o pedido ja tem a mao.
            n.id AS nota_id, n.chave_acesso, n.serie, n.numero,
            n.status AS status_nota, n.ambiente, n.criado_em AS nota_em,
            n.mensagens AS mensagens_sefin, n.ultimo_erro
       FROM solicitacoes s
       LEFT JOIN empresas e ON e.id = s.empresa_id
       LEFT JOIN notas n    ON n.id = s.nota_id
      WHERE right(regexp_replace(s.remetente, '\\D', '', 'g'), 8) = $1${filtro}
      ORDER BY s.recebida_em DESC
      LIMIT 100`, params);

  /* A auditoria aponta para o pedido pelo id_externo — é assim que "quem
     liberou" se liga a "o que foi pedido". */
  const chaves = pedidos.rows.map(p => p.id_externo).filter(Boolean);
  const auditoria = chaves.length
    ? (await db.query(
        `SELECT referencia, acao, autor, ocorrido_em, descricao
           FROM auditoria WHERE referencia = ANY($1::text[])
          ORDER BY ocorrido_em`, [chaves])).rows
    : [];

  const contato = (await db.query(
    `SELECT c.telefone, c.nome, c.cargo, c.limite_valor, c.criado_em,
            e.razao_social, e.cnpj
       FROM contatos_whatsapp c
       LEFT JOIN empresas e ON e.id = c.empresa_id
      WHERE right(regexp_replace(c.telefone, '\\D', '', 'g'), 8) = $1`, [s])).rows;

  return {
    telefone: pedidos.rows.length ? pedidos.rows[0].remetente : telefone,
    autorizacoes: contato,
    pedidos: pedidos.rows.map(p => Object.assign({}, p, {
      auditoria: auditoria.filter(a => a.referencia === p.id_externo)
    }))
  };
}

/* ----------------------------- o que o próprio cliente pode consultar */

/* AS NOTAS DELE, e só as dele.
 *
 * "Dele" quer dizer: as que nasceram dos pedidos daquele telefone. Não as da
 * empresa — o número da financeira de um cliente não deve enxergar o que o
 * sócio pediu por outro canal — e muito menos as do escritório.
 *
 * Esse recorte é o que permite o cliente consultar sozinho, pelo WhatsApp, sem
 * que isso abra nada: o que ele alcança é o que ele já pediu e já recebeu. */
async function notasDoCliente(telefone, limite) {
  const s = sufixo(telefone);
  if (s.length < 8) {
    throw Object.assign(new Error('Telefone inválido.'), { status: 400 });
  }
  const n = Math.min(Math.max(Number(limite) || 5, 1), 20);

  const r = await db.query(
    `SELECT n.chave_acesso, n.serie, n.numero, n.status, n.criado_em,
            e.razao_social AS empresa,
            s.payload->'tomador'->>'razaoSocial'        AS tomador,
            s.payload->'servico'->>'descricao'          AS servico,
            s.payload->'valores'->>'valorServico'       AS valor
       FROM solicitacoes s
       JOIN notas n    ON n.id = s.nota_id
       JOIN empresas e ON e.id = s.empresa_id
      WHERE right(regexp_replace(s.remetente, '\\D', '', 'g'), 8) = $1
        AND n.chave_acesso IS NOT NULL
      ORDER BY n.criado_em DESC
      LIMIT $2`, [s, n]);

  return r.rows;
}

/* A SEGUNDA VIA de uma nota que já saiu.
 *
 * O acesso é conferido do mesmo jeito: a chave precisa pertencer a um pedido
 * DAQUELE telefone. Pedir a chave e devolver o PDF sem essa conferência
 * transformaria a conversa numa porta para baixar nota de qualquer um que
 * adivinhasse uma chave.
 *
 * Devolve o PDF e o XML em base64 — quem envia é o repassador, pelo transporte
 * que estiver ativo. O gateway não sabe nem precisa saber qual é. */
async function documentoDoCliente(telefone, chave) {
  const s = sufixo(telefone);
  const c = String(chave || '').replace(/\s/g, '');
  if (s.length < 8 || !c) {
    throw Object.assign(new Error('Telefone ou chave inválidos.'), { status: 400 });
  }

  const r = await db.query(
    `SELECT n.id, n.empresa_id, n.chave_acesso, n.serie, n.numero, n.nfse_xml
       FROM solicitacoes s
       JOIN notas n ON n.id = s.nota_id
      WHERE right(regexp_replace(s.remetente, '\\D', '', 'g'), 8) = $1
        AND n.chave_acesso = $2
      LIMIT 1`, [s, c]);

  const nota = r.rows[0];
  if (!nota) {
    /* Mesma resposta para "não existe" e "não é sua": distinguir as duas diria
       a quem tentasse que aquela chave existe em algum lugar. */
    throw Object.assign(new Error('Não encontrei essa nota entre as suas.'), { status: 404 });
  }
  if (!nota.nfse_xml) {
    throw Object.assign(new Error('Essa nota ainda não tem documento.'), { status: 409 });
  }

  const { gerarDanfse } = require('../nfse/danfse');
  const pdf = await gerarDanfse(nota.nfse_xml, {});

  return {
    empresaId: nota.empresa_id,
    chave: nota.chave_acesso,
    nome: 'NFSe-' + (nota.serie || '1') + '-' + (nota.numero || ''),
    pdf: Buffer.from(pdf).toString('base64'),
    xml: Buffer.from(nota.nfse_xml, 'utf8').toString('base64')
  };
}

module.exports = { listar, historico, notasDoCliente, documentoDoCliente, sufixo };
