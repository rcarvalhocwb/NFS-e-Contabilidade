const fs = require('fs');
const path = require('path');
const db = require('../db');
const { dadosDoXml } = require('../nfse/danfse');
const { limparDocumento } = require('../util/documento');

/* As notas que a empresa recebe, e como achá-las.
 *
 * O escritório passa o mês procurando nota de entrada: a do fornecedor, a que
 * sumiu no e-mail, a que falta na apuração. Hoje isso é abrir pasta e ler XML
 * no bloco de notas.
 *
 * A NOTA É DE QUEM A RECEBEU. O vínculo com a empresa sai do CNPJ do tomador
 * dentro do próprio XML, nunca de quem está importando — senão bastaria um
 * operador escolher a empresa errada na tela para a nota de um cliente entrar
 * na apuração de outro.
 */

/* Reaproveita o leitor da DANFSe: é o mesmo layout nacional, já usado para
   desenhar o PDF e conferido contra as NT 008 e 009. Ter um segundo leitor
   seria ter duas leituras do mesmo XML, divergindo com o tempo. */
function lerNfse(xml) {
  const d = dadosDoXml(xml);
  if (!d.chave) {
    throw Object.assign(new Error(
      'Não parece uma NFS-e do Sistema Nacional: não achei a chave de acesso ' +
      'dentro do XML.'), { status: 422 });
  }
  return d;
}

function numeroOuNulo(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/* dCompet vem como AAAA-MM-DD; dhProc, com fuso. Guardar como veio e deixar o
   Postgres converter evita reinventar leitura de data. */
function dataOuNulo(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d) ? null : d;
}

/* --------------------------------------------------------------- importar */

/* Guarda uma nota recebida. Devolve o que aconteceu, por arquivo — quem importa
   uma pasta com trinta XMLs precisa saber quais entraram e por que os outros
   não. Uma exceção derrubaria o lote inteiro por causa de um arquivo torto. */
async function guardar(xml, arquivo) {
  let d;
  try {
    d = lerNfse(xml);
  } catch (e) {
    return { arquivo, ok: false, motivo: e.message };
  }

  const docTomador = limparDocumento(d.tomador.doc || '');
  if (!docTomador) {
    return { arquivo, ok: false, chave: d.chave,
             motivo: 'A nota não traz o documento do tomador — não dá para saber de quem ela é.' };
  }

  const emp = await db.query(
    'SELECT id, razao_social FROM empresas WHERE cnpj = $1', [docTomador]);
  if (!emp.rows.length) {
    return { arquivo, ok: false, chave: d.chave,
             motivo: 'O tomador ' + docTomador + ' (' + (d.tomador.nome || 'sem nome') +
                     ') não é uma empresa cadastrada aqui.' };
  }

  /* Reimportar o mesmo arquivo atualiza em vez de duplicar. A pasta do
     escritório é importada mais de uma vez — é assim que se descobre o que
     chegou de novo — e nota dobrada é apuração dobrada. */
  const r = await db.query(
    `INSERT INTO notas_entrada (
       empresa_id, chave_acesso, numero, serie, emitido_em, competencia,
       prestador_doc, prestador_nome, prestador_municipio,
       tomador_doc, tomador_nome, cod_tributacao, descricao,
       municipio_incidencia, valor_servico, valor_iss, valor_liquido,
       aliquota, iss_retido, situacao, origem, arquivo, xml)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
     ON CONFLICT (chave_acesso) DO UPDATE SET
       situacao = EXCLUDED.situacao, xml = EXCLUDED.xml, arquivo = EXCLUDED.arquivo
     RETURNING id, (xmax = 0) AS nova`,
    [emp.rows[0].id, d.chave, d.numero, d.serie,
     dataOuNulo(d.dhProc), dataOuNulo(d.competencia),
     limparDocumento(d.emitente.cnpj || ''), d.emitente.nome, d.locEmi,
     docTomador, d.tomador.nome, d.cTribNac, d.descServico,
     d.locIncid, numeroOuNulo(d.valorServico), numeroOuNulo(d.vISSQN),
     numeroOuNulo(d.vLiq), numeroOuNulo(d.pAliqAplic),
     d.tpRetISSQN ? d.tpRetISSQN !== '1' : null,
     /* cStat 101/135 são cancelamento no leiaute nacional. Sem isso, nota
        cancelada entraria na apuração como se valesse. */
     ['101', '135'].includes(String(d.cStat)) ? 'cancelada' : 'autorizada',
     'xml', arquivo || null, xml]);

  return {
    arquivo, ok: true, chave: d.chave, id: r.rows[0].id,
    nova: r.rows[0].nova,
    empresa: emp.rows[0].razao_social,
    prestador: d.emitente.nome,
    valor: numeroOuNulo(d.valorServico)
  };
}

async function importar(arquivos) {
  const resultados = [];
  for (const a of arquivos) {
    resultados.push(await guardar(a.xml, a.nome));
  }
  return {
    total: resultados.length,
    novas: resultados.filter(r => r.ok && r.nova).length,
    repetidas: resultados.filter(r => r.ok && !r.nova).length,
    recusadas: resultados.filter(r => !r.ok).length,
    resultados
  };
}

/* A pasta onde o escritório despeja os XMLs. É como o trabalho já é feito:
   baixa do e-mail, joga numa pasta, e alguém abre um por um. */
async function importarPasta(pasta) {
  let nomes;
  try {
    nomes = fs.readdirSync(pasta).filter(n => /\.xml$/i.test(n));
  } catch (e) {
    throw Object.assign(new Error('Não consegui ler a pasta ' + pasta + ': ' + e.message),
      { status: 400 });
  }
  if (!nomes.length) {
    throw Object.assign(new Error('Nenhum arquivo .xml em ' + pasta + '.'), { status: 400 });
  }

  const arquivos = [];
  for (const n of nomes.slice(0, 500)) {
    try {
      arquivos.push({ nome: n, xml: fs.readFileSync(path.join(pasta, n), 'utf8') });
    } catch (e) {
      arquivos.push({ nome: n, xml: '' });
    }
  }
  const r = await importar(arquivos);
  r.pasta = pasta;
  r.ignorados = Math.max(0, nomes.length - 500);
  return r;
}

/* ----------------------------------------------------------------- buscar */

/* Transforma o que a pessoa digitou numa consulta de texto.
 *
 * `websearch_to_tsquery` entende aspas e "-palavra", que é como as pessoas já
 * procuram em qualquer buscador, e nunca estoura com pontuação solta — coisa
 * que `to_tsquery` faz e derrubaria a tela.
 *
 * Número de nota, CNPJ e chave não são texto: quem digita 21583854000118 quer
 * aquele documento, não algo parecido. Por isso os dígitos viram um filtro
 * próprio, em paralelo com a busca textual. */
function preparar(termo) {
  const texto = String(termo || '').trim();
  const digitos = texto.replace(/\D/g, '');
  return {
    texto: texto || null,
    /* 3 dígitos já é número de nota; menos que isso pega qualquer coisa. */
    digitos: digitos.length >= 3 ? digitos : null
  };
}

async function buscar(filtros = {}, empresasVisiveis = null) {
  const p = [];
  const onde = [];
  const add = v => { p.push(v); return '$' + p.length; };

  /* O escopo vem primeiro e não é opcional: um cliente da contabilidade não
     pode ver a nota de entrada de outro. `null` = enxerga tudo (administrador);
     lista vazia = não enxerga nada, e é diferente de "sem filtro". */
  if (empresasVisiveis !== null) {
    if (!empresasVisiveis.length) return { total: 0, itens: [], soma: 0 };
    onde.push('n.empresa_id = ANY(' + add(empresasVisiveis) + '::int[])');
  }
  if (filtros.empresaId) onde.push('n.empresa_id = ' + add(Number(filtros.empresaId)));

  const q = preparar(filtros.busca);
  let ordem = 'n.emitido_em DESC NULLS LAST';
  let selecaoRank = '';

  if (q.texto) {
    /* O placeholder é guardado, não procurado depois: `p.indexOf(valor)` acha a
       PRIMEIRA ocorrência, e bastaria alguém buscar por um texto igual a outro
       filtro para o ranking passar a ordenar pelo parâmetro errado. */
    const pTexto = add(q.texto);

    const alvo = ['n.busca @@ websearch_to_tsquery(\'portuguese\', ' + pTexto + ')'];
    if (q.digitos) {
      const d = add(q.digitos + '%');
      alvo.push('(n.numero LIKE ' + d + ' OR n.chave_acesso LIKE ' + d +
                ' OR n.prestador_doc LIKE ' + d + ')');
    }
    onde.push('(' + alvo.join(' OR ') + ')');

    /* Ordenar por relevância só faz sentido quando há termo. Sem ele, o que a
       pessoa quer é a nota mais recente. */
    selecaoRank = ', ts_rank(n.busca, websearch_to_tsquery(\'portuguese\', ' +
      pTexto + ')) AS relevancia';
    ordem = 'relevancia DESC, n.emitido_em DESC NULLS LAST';
  }

  if (filtros.de) onde.push('n.emitido_em >= ' + add(filtros.de));
  if (filtros.ate) onde.push('n.emitido_em < (' + add(filtros.ate) + '::date + 1)');
  if (filtros.prestador) {
    onde.push('n.prestador_doc = ' + add(limparDocumento(String(filtros.prestador))));
  }
  if (filtros.valorMin !== undefined && filtros.valorMin !== '') {
    onde.push('n.valor_servico >= ' + add(Number(filtros.valorMin)));
  }
  if (filtros.valorMax !== undefined && filtros.valorMax !== '') {
    onde.push('n.valor_servico <= ' + add(Number(filtros.valorMax)));
  }
  if (filtros.situacao) onde.push('n.situacao = ' + add(filtros.situacao));

  const filtro = onde.length ? 'WHERE ' + onde.join(' AND ') : '';
  const limite = Math.min(Number(filtros.limite) || 50, 200);

  const sql =
    `SELECT n.id, n.chave_acesso, n.numero, n.serie, n.emitido_em, n.competencia,
            n.prestador_doc, n.prestador_nome, n.prestador_municipio,
            n.cod_tributacao, n.descricao, n.valor_servico, n.valor_iss,
            n.valor_liquido, n.iss_retido, n.situacao, n.arquivo,
            e.razao_social, e.nome_fantasia${selecaoRank}
       FROM notas_entrada n JOIN empresas e ON e.id = n.empresa_id
       ${filtro}
      ORDER BY ${ordem}
      LIMIT ${limite}`;

  const [itens, resumo] = await Promise.all([
    db.query(sql, p),
    db.query(`SELECT count(*)::int total, coalesce(sum(n.valor_servico), 0) soma
                FROM notas_entrada n ${filtro}`, p)
  ]);

  return {
    total: resumo.rows[0].total,
    soma: Number(resumo.rows[0].soma),
    mostrando: itens.rows.length,
    itens: itens.rows
  };
}

async function xmlDe(id, empresasVisiveis = null) {
  const p = [Number(id)];
  let filtro = '';
  if (empresasVisiveis !== null) {
    if (!empresasVisiveis.length) return null;
    p.push(empresasVisiveis);
    filtro = ' AND empresa_id = ANY($2::int[])';
  }
  const r = await db.query(
    'SELECT chave_acesso, xml FROM notas_entrada WHERE id = $1' + filtro, p);
  return r.rows[0] || null;
}

/* Quem mais mandou nota para esta empresa. Serve para a tela oferecer o filtro
   por fornecedor sem obrigar ninguém a decorar CNPJ. */
async function fornecedores(empresasVisiveis = null) {
  const p = [];
  let filtro = '';
  if (empresasVisiveis !== null) {
    if (!empresasVisiveis.length) return [];
    p.push(empresasVisiveis);
    filtro = 'WHERE empresa_id = ANY($1::int[])';
  }
  /* Agrupa pelo documento, que é quem identifica o prestador de verdade — o
     nome varia entre notas do mesmo CNPJ (razão social, fantasia, abreviação).
     Mas quando o documento NÃO veio no XML, agrupar por ele junta prestadores
     que não têm nada a ver um com o outro: todos ficam com o mesmo "" e viram
     uma linha só, com o nome de um e o dinheiro de todos.

     Visto na prática: duas notas de entrada, dois prestadores distintos, uma
     linha de R$ 1.777 — e a segunda empresa nem aparecia na tela. Numa
     apuração, isso é o contador conferindo um fornecedor que não existe.

     "Sem documento" acontece com prestador de fora (NIF em vez de CNPJ/CPF) e
     com XML fora do leiaute. É pouco, mas some justamente onde a conferência
     importa. Sem documento, o nome passa a ser a identidade: é o único dado
     que resta para distinguir um do outro. */
  const r = await db.query(
    `SELECT prestador_doc, max(prestador_nome) nome,
            count(*)::int notas, sum(valor_servico) total
       FROM notas_entrada ${filtro}
      GROUP BY prestador_doc,
               CASE WHEN coalesce(prestador_doc, '') = '' THEN prestador_nome END
      ORDER BY total DESC NULLS LAST LIMIT 50`, p);
  return r.rows;
}

module.exports = { importar, importarPasta, buscar, xmlDe, fornecedores, lerNfse };
