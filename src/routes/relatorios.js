const express = require('express');
const db = require('../db');
const { gerarCsv } = require('../util/csv');
const { empresasVisiveis } = require('../middleware/escopo');
const { extrairValores, baseCalculo, valorIss, totalRetencoesFederais } =
  require('../nfse/extrairValores');

const router = express.Router();

/**
 * Relatórios de fechamento.
 *
 * O escritório fecha o mês por empresa: quanto foi emitido, quanto de ISS,
 * o que ficou retido. Hoje isso saía do gateway como um ZIP de XMLs, que não
 * responde nenhuma dessas perguntas sem alguém abrir um por um.
 */

function periodo(req) {
  const hoje = new Date();
  const inicio = req.query.inicio ||
    new Date(hoje.getFullYear(), hoje.getMonth(), 1).toISOString().slice(0, 10);
  const fim = req.query.fim || hoje.toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(inicio) || !/^\d{4}-\d{2}-\d{2}$/.test(fim)) {
    throw Object.assign(new Error('Datas devem estar no formato AAAA-MM-DD'), { status: 400 });
  }
  return { inicio, fim };
}

/* Consulta base: uma linha por nota do período, com os valores extraídos do
   JSON da emissão. Os valores ficam no XML e no retorno da Sefin; guardar uma
   cópia em coluna própria seria duplicar a fonte da verdade. */
const SQL_NOTAS = `
  SELECT n.id, n.numero, n.serie, n.status, n.ambiente, n.chave_acesso,
         n.referencia, n.criado_em, n.dps_xml,
         e.id AS empresa_id, e.cnpj, e.razao_social, e.op_simp_nac,
         u.nome AS emitida_por
    FROM notas n
    JOIN empresas e ON e.id = n.empresa_id
    LEFT JOIN usuarios u ON u.id = n.usuario_id
   WHERE n.criado_em >= $1::date
     AND n.criado_em < ($2::date + interval '1 day')
     AND ($3::int[] IS NULL OR n.empresa_id = ANY($3::int[]))
     AND ($4::int IS NULL OR n.empresa_id = $4)
     AND ($5::text IS NULL OR n.ambiente = $5)
   ORDER BY e.razao_social, n.numero`;

function montarLinhas(rows) {
  return rows.map(n => {
    const v = extrairValores(n.dps_xml);
    const base = baseCalculo(v);
    const iss = valorIss(v);
    return {
      empresa: n.razao_social, cnpj: n.cnpj, empresaId: n.empresa_id,
      numero: n.numero, serie: n.serie, status: n.status, ambiente: n.ambiente,
      data: n.criado_em, referencia: n.referencia, chave: n.chave_acesso,
      tomador: v.tomador, docTomador: v.docTomador, descricao: v.descricao,
      valorServico: v.valorServico || 0,
      desconto: v.desconto || 0,
      deducoes: v.deducoes || 0,
      baseCalculo: base,
      aliquota: v.aliquota,
      valorIss: iss,
      issRetido: v.issRetido,
      retencoesFederais: totalRetencoesFederais(v),
      emitidaPor: n.emitida_por,
      optanteSimples: [2, 3].includes(Number(n.op_simp_nac))
    };
  });
}

async function buscar(req) {
  const { inicio, fim } = periodo(req);
  const r = await db.query(SQL_NOTAS, [
    inicio, fim, empresasVisiveis(req),
    req.query.empresaId ? Number(req.query.empresaId) : null,
    req.query.ambiente || null
  ]);
  return { inicio, fim, linhas: montarLinhas(r.rows) };
}

/* Fechamento: totais por empresa, que é como o escritório fecha o mês. */
router.get('/fechamento', async (req, res, next) => {
  try {
    const { inicio, fim, linhas } = await buscar(req);
    const autorizadas = linhas.filter(l => l.status === 'autorizada');

    const porEmpresa = {};
    for (const l of autorizadas) {
      const k = l.cnpj;
      if (!porEmpresa[k]) {
        porEmpresa[k] = {
          empresa: l.empresa, cnpj: l.cnpj, optanteSimples: l.optanteSimples,
          notas: 0, valorServico: 0, baseCalculo: 0, valorIss: 0,
          issRetido: 0, retencoesFederais: 0
        };
      }
      const e = porEmpresa[k];
      e.notas++;
      e.valorServico += l.valorServico;
      e.baseCalculo += l.baseCalculo;
      if (l.valorIss) {
        e.valorIss += l.valorIss;
        if (l.issRetido) e.issRetido += l.valorIss;
      }
      e.retencoesFederais += l.retencoesFederais;
    }

    const arredondar = o => {
      for (const k of ['valorServico','baseCalculo','valorIss','issRetido','retencoesFederais']) {
        o[k] = Math.round(o[k] * 100) / 100;
      }
      return o;
    };
    const empresas = Object.values(porEmpresa).map(arredondar);

    res.json({
      periodo: { inicio, fim },
      empresas,
      totais: arredondar(empresas.reduce((t, e) => ({
        notas: t.notas + e.notas,
        valorServico: t.valorServico + e.valorServico,
        baseCalculo: t.baseCalculo + e.baseCalculo,
        valorIss: t.valorIss + e.valorIss,
        issRetido: t.issRetido + e.issRetido,
        retencoesFederais: t.retencoesFederais + e.retencoesFederais
      }), { notas: 0, valorServico: 0, baseCalculo: 0, valorIss: 0, issRetido: 0, retencoesFederais: 0 })),
      // O contador precisa saber o que ficou de fora do fechamento
      naoAutorizadas: linhas.filter(l => l.status !== 'autorizada')
        .map(l => ({ empresa: l.empresa, numero: l.numero, serie: l.serie,
                     status: l.status, referencia: l.referencia }))
    });
  } catch (e) { next(e); }
});

/* Livro de notas: uma linha por nota, para conferência e para a contabilidade. */
router.get('/notas', async (req, res, next) => {
  try {
    const { inicio, fim, linhas } = await buscar(req);
    res.json({ periodo: { inicio, fim }, total: linhas.length, notas: linhas });
  } catch (e) { next(e); }
});

/* O mesmo livro em CSV, que é como isso entra no sistema contábil. */
router.get('/notas.csv', async (req, res, next) => {
  try {
    const { inicio, fim, linhas } = await buscar(req);
    const dec = v => (v === null || v === undefined ? '' : String(v).replace('.', ','));
    const csv = gerarCsv([
      { titulo: 'Empresa', campo: 'empresa' },
      { titulo: 'CNPJ', campo: 'cnpj' },
      { titulo: 'Serie', campo: 'serie' },
      { titulo: 'Numero', campo: 'numero' },
      { titulo: 'Data', campo: 'dataFmt' },
      { titulo: 'Status', campo: 'status' },
      { titulo: 'Ambiente', campo: 'ambiente' },
      { titulo: 'Tomador', campo: 'tomador' },
      { titulo: 'Doc. Tomador', campo: 'docTomador' },
      { titulo: 'Descricao', campo: 'descricao' },
      { titulo: 'Valor do servico', campo: 'valorFmt' },
      { titulo: 'Desconto', campo: 'descontoFmt' },
      { titulo: 'Deducoes', campo: 'deducoesFmt' },
      { titulo: 'Base de calculo', campo: 'baseFmt' },
      { titulo: 'Aliquota ISS', campo: 'aliquotaFmt' },
      { titulo: 'Valor do ISS', campo: 'issFmt' },
      { titulo: 'ISS retido', campo: 'retidoFmt' },
      { titulo: 'Retencoes federais', campo: 'retFedFmt' },
      { titulo: 'Referencia', campo: 'referencia' },
      { titulo: 'Chave de acesso', campo: 'chave' },
      { titulo: 'Emitida por', campo: 'emitidaPor' }
    ], linhas.map(l => Object.assign({}, l, {
      dataFmt: new Date(l.data).toLocaleDateString('pt-BR'),
      valorFmt: dec(l.valorServico), descontoFmt: dec(l.desconto),
      deducoesFmt: dec(l.deducoes), baseFmt: dec(l.baseCalculo),
      aliquotaFmt: dec(l.aliquota), issFmt: dec(l.valorIss),
      retidoFmt: l.issRetido ? 'Sim' : 'Nao', retFedFmt: dec(l.retencoesFederais)
    })));

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition',
      `attachment; filename="nfse-${inicio}-a-${fim}.csv"`);
    res.send(csv);
  } catch (e) { next(e); }
});

module.exports = router;
