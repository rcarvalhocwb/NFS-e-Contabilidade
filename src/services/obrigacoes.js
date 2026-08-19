/* Calendário de obrigações por cliente.
 *
 * O escritório acompanha, para cada cliente, compromissos que se repetem: DAS,
 * ISS do município, EFD-Reinf, DCTFWeb, fechamento interno. Isso costuma viver
 * numa planilha separada do sistema que conhece o movimento do cliente — e a
 * planilha não sabe que o cliente não emitiu nada este mês.
 *
 * O QUE ESTE MÓDULO NÃO FAZ: não traz prazos legais embutidos. Quem cadastra o
 * vencimento é o escritório. Prazo de obrigação acessória muda por lei,
 * portaria e calendário municipal, e um prazo desatualizado dentro do software
 * vira multa para o cliente — com o agravante de parecer confiável por estar na
 * tela. Os modelos sugeridos existem para poupar digitação, não para responder
 * pelo prazo.
 */
const db = require('../db');
const { dataLocalISO } = require('../util/data');

/* Modelos oferecidos no primeiro uso. São ponto de partida: o escritório
   confere e ajusta cada prazo antes de valer. */
const SUGESTOES = [
  { nome: 'DAS — Simples Nacional', periodicidade: 'mensal', diaVencimento: 20, deslocaMeses: 1,
    descricao: 'Documento de Arrecadação do Simples Nacional. Confira o prazo vigente.' },
  { nome: 'ISS próprio', periodicidade: 'mensal', diaVencimento: 10, deslocaMeses: 1,
    descricao: 'Recolhimento do ISS ao município. O dia varia por município.' },
  { nome: 'EFD-Reinf', periodicidade: 'mensal', diaVencimento: 15, deslocaMeses: 1,
    descricao: 'Escrituração de retenções. Confira o prazo vigente.' },
  { nome: 'DCTFWeb', periodicidade: 'mensal', diaVencimento: 15, deslocaMeses: 1,
    descricao: 'Confira o prazo vigente.' },
  { nome: 'Fechamento contábil do mês', periodicidade: 'mensal', diaVencimento: 10, deslocaMeses: 1,
    descricao: 'Rotina interna do escritório: conferir notas, retenções e faturamento.' }
];

/* Vencimento de uma competência, respeitando meses curtos.
   Dia 31 num mês de 30 cai no dia 30, não escorrega para o mês seguinte. */
function calcularVencimento(competencia, modelo) {
  const [ano, mes] = competencia.split('-').map(Number);
  const desloca = Number(modelo.desloca_meses ?? modelo.deslocaMeses ?? 0);
  const alvo = new Date(ano, (mes - 1) + desloca, 1);
  const ultimoDia = new Date(alvo.getFullYear(), alvo.getMonth() + 1, 0).getDate();
  const dia = Math.min(Number(modelo.dia_vencimento ?? modelo.diaVencimento ?? 20), ultimoDia);
  return dataLocalISO(new Date(alvo.getFullYear(), alvo.getMonth(), dia));
}

/* A competência pertence a este modelo?
   Trimestral vence nos meses 3, 6, 9 e 12; anual, no mês configurado. */
function competenciaVale(competencia, modelo) {
  const mes = Number(competencia.split('-')[1]);
  const p = modelo.periodicidade;
  if (p === 'mensal') return true;
  if (p === 'trimestral') return mes % 3 === 0;
  if (p === 'anual') return mes === Number(modelo.mes_vencimento || 12);
  return false;  // 'unica' não se repete: é criada à mão
}

function competenciaDe(data = new Date()) {
  return dataLocalISO(data).slice(0, 7);
}

/* Competências de hoje até `meses` à frente. */
function proximasCompetencias(meses = 3, hoje = new Date()) {
  const lista = [];
  for (let i = 0; i <= meses; i++) {
    const d = new Date(hoje.getFullYear(), hoje.getMonth() + i, 1);
    lista.push(competenciaDe(d));
  }
  return lista;
}

/**
 * Cria as ocorrências que faltam, para os clientes que têm cada obrigação.
 *
 * Idempotente: rodar duas vezes não duplica nada (UNIQUE por empresa, modelo e
 * competência). Não mexe em ocorrência existente — se alguém já concluiu ou
 * ajustou a data, a geração não desfaz.
 */
async function gerar({ meses = 3, empresaId = null } = {}) {
  const vinculos = await db.query(
    `SELECT eo.empresa_id, m.*
       FROM empresa_obrigacoes eo
       JOIN obrigacao_modelos m ON m.id = eo.modelo_id
       JOIN empresas e ON e.id = eo.empresa_id
      WHERE eo.ativo AND m.ativo AND e.ativo
        AND ($1::int IS NULL OR eo.empresa_id = $1)`, [empresaId]);

  const competencias = proximasCompetencias(meses);
  let criadas = 0;

  for (const v of vinculos.rows) {
    for (const competencia of competencias) {
      if (!competenciaVale(competencia, v)) continue;
      const r = await db.query(
        `INSERT INTO obrigacoes (empresa_id, modelo_id, nome, competencia, vencimento)
         VALUES ($1,$2,$3,$4,$5::date)
         ON CONFLICT (empresa_id, modelo_id, competencia) DO NOTHING
         RETURNING id`,
        [v.empresa_id, v.id, v.nome, competencia, calcularVencimento(competencia, v)]);
      criadas += r.rowCount;
    }
  }
  return { criadas, competencias };
}

/* Agenda: o que vence, o que atrasou, por cliente.
   `dias` limita o horizonte à frente; atrasadas entram sempre, porque atraso
   não deixa de existir por ser antigo. */
async function agenda({ empresasIds = null, dias = 30, incluirConcluidas = false } = {}) {
  const r = await db.query(
    `SELECT o.id, o.empresa_id, e.razao_social, e.cnpj, o.nome, o.competencia,
            o.vencimento, o.situacao, o.observacao, o.concluida_em, o.concluida_por,
            u.nome AS responsavel,
            (o.vencimento - CURRENT_DATE) AS dias_para_vencer
       FROM obrigacoes o
       JOIN empresas e ON e.id = o.empresa_id
       LEFT JOIN usuarios u ON u.id = o.responsavel_id
      WHERE e.ativo
        AND ($1::int[] IS NULL OR o.empresa_id = ANY($1::int[]))
        AND ($2::bool OR o.situacao = 'pendente')
        AND (o.situacao <> 'pendente'
             OR o.vencimento <= CURRENT_DATE + ($3 || ' days')::interval)
      ORDER BY o.vencimento, e.razao_social`,
    [empresasIds, incluirConcluidas, String(Number(dias) || 30)]);

  const hoje = dataLocalISO();
  return r.rows.map(o => Object.assign(o, {
    atrasada: o.situacao === 'pendente' && dataLocalISO(new Date(o.vencimento)) < hoje
  }));
}

/* Resumo por cliente, para a tela de gestão. */
async function resumoPorEmpresa(empresaId) {
  const r = await db.query(
    `SELECT
       COUNT(*) FILTER (WHERE situacao = 'pendente' AND vencimento < CURRENT_DATE)  AS atrasadas,
       COUNT(*) FILTER (WHERE situacao = 'pendente'
                          AND vencimento BETWEEN CURRENT_DATE AND CURRENT_DATE + 7) AS proximas,
       COUNT(*) FILTER (WHERE situacao = 'pendente')                                AS pendentes,
       COUNT(*) FILTER (WHERE situacao = 'concluida'
                          AND concluida_em > now() - interval '30 days')            AS concluidas_30d
     FROM obrigacoes WHERE empresa_id = $1`, [empresaId]);
  const n = r.rows[0];
  return {
    atrasadas: Number(n.atrasadas), proximas: Number(n.proximas),
    pendentes: Number(n.pendentes), concluidas30d: Number(n.concluidas_30d)
  };
}

/* Instala os modelos sugeridos. Só roda quando não há nenhum: o objetivo é
   poupar a primeira digitação, não repor o que o escritório apagou de propósito. */
async function instalarSugestoes() {
  const existe = await db.query('SELECT 1 FROM obrigacao_modelos LIMIT 1');
  if (existe.rows.length) return { instalados: 0, motivo: 'já existem modelos' };

  for (const s of SUGESTOES) {
    await db.query(
      `INSERT INTO obrigacao_modelos (nome, descricao, periodicidade, dia_vencimento, desloca_meses)
       VALUES ($1,$2,$3,$4,$5)`,
      [s.nome, s.descricao, s.periodicidade, s.diaVencimento, s.deslocaMeses]);
  }
  return { instalados: SUGESTOES.length };
}

module.exports = {
  gerar, agenda, resumoPorEmpresa, instalarSugestoes,
  calcularVencimento, competenciaVale, proximasCompetencias, competenciaDe,
  SUGESTOES
};
