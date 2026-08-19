const express = require('express');
const db = require('../db');
const obrigacoes = require('../services/obrigacoes');
const auditoria = require('../services/auditoria');
const { somenteAdmin, empresasVisiveis, empresaVisivel } = require('../middleware/escopo');

const router = express.Router();

/* Agenda do escritório: o que vence e o que atrasou, já filtrado pelo escopo
   de quem abriu a tela. É o que se olha de manhã. */
router.get('/agenda', async (req, res, next) => {
  try {
    res.json(await obrigacoes.agenda({
      empresasIds: empresasVisiveis(req),
      dias: Math.min(Number(req.query.dias) || 30, 365),
      incluirConcluidas: req.query.concluidas === '1'
    }));
  } catch (e) { next(e); }
});

/* ------------------------------------------------- modelos do escritório */

router.get('/modelos', async (_req, res, next) => {
  try {
    const r = await db.query(
      `SELECT m.*, (SELECT COUNT(*) FROM empresa_obrigacoes eo
                     WHERE eo.modelo_id = m.id AND eo.ativo) AS clientes
         FROM obrigacao_modelos m ORDER BY m.ativo DESC, m.nome`);
    res.json(r.rows);
  } catch (e) { next(e); }
});

router.post('/modelos', somenteAdmin, async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.nome) return res.status(400).json({ erro: 'Dê um nome à obrigação.' });

    const periodicidades = ['mensal', 'trimestral', 'anual', 'unica'];
    if (b.periodicidade && !periodicidades.includes(b.periodicidade)) {
      return res.status(400).json({ erro: 'Periodicidade deve ser mensal, trimestral, anual ou única.' });
    }
    const dia = Number(b.diaVencimento || 20);
    if (!Number.isInteger(dia) || dia < 1 || dia > 31) {
      return res.status(400).json({ erro: 'O dia do vencimento vai de 1 a 31.' });
    }

    const r = await db.query(
      `INSERT INTO obrigacao_modelos (nome, descricao, periodicidade, dia_vencimento,
                                      mes_vencimento, desloca_meses, alerta_dias)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [b.nome, b.descricao || null, b.periodicidade || 'mensal', dia,
       b.mesVencimento || null, Number(b.deslocaMeses ?? 1), Number(b.alertaDias ?? 5)]);

    await auditoria.registrar(req, null, 'obrigacao.modelo_criado',
      'Criou a obrigação "' + b.nome + '"', { detalhe: { periodicidade: b.periodicidade || 'mensal', dia } });
    res.status(201).json(r.rows[0]);
  } catch (e) { next(e); }
});

router.put('/modelos/:id', somenteAdmin, async (req, res, next) => {
  try {
    const b = req.body || {};
    const r = await db.query(
      `UPDATE obrigacao_modelos SET
         nome = COALESCE($2, nome), descricao = COALESCE($3, descricao),
         periodicidade = COALESCE($4, periodicidade),
         dia_vencimento = COALESCE($5, dia_vencimento),
         mes_vencimento = COALESCE($6, mes_vencimento),
         desloca_meses = COALESCE($7, desloca_meses),
         alerta_dias = COALESCE($8, alerta_dias),
         ativo = COALESCE($9, ativo)
       WHERE id = $1 RETURNING *`,
      [req.params.id, b.nome ?? null, b.descricao ?? null, b.periodicidade ?? null,
       b.diaVencimento ?? null, b.mesVencimento ?? null, b.deslocaMeses ?? null,
       b.alertaDias ?? null, b.ativo ?? null]);
    if (!r.rows.length) return res.status(404).json({ erro: 'Obrigação não encontrada' });
    res.json(r.rows[0]);
  } catch (e) { next(e); }
});

/* Modelos sugeridos, para o escritório não começar de uma tela vazia. */
router.post('/modelos/sugestoes', somenteAdmin, async (req, res, next) => {
  try {
    const r = await obrigacoes.instalarSugestoes();
    if (r.instalados) {
      await auditoria.registrar(req, null, 'obrigacao.sugestoes',
        'Instalou ' + r.instalados + ' obrigações sugeridas');
    }
    res.json(r);
  } catch (e) { next(e); }
});

/* --------------------------------------------- obrigações de um cliente */

router.get('/empresa/:id', async (req, res, next) => {
  try {
    const empresaId = Number(req.params.id);
    if (!empresaVisivel(req, empresaId)) {
      return res.status(404).json({ erro: 'Empresa não encontrada' });
    }
    const [vinculos, lista, resumo] = await Promise.all([
      db.query(
        `SELECT m.id, m.nome, m.periodicidade, m.dia_vencimento, m.desloca_meses,
                (eo.empresa_id IS NOT NULL AND eo.ativo) AS vinculada
           FROM obrigacao_modelos m
           LEFT JOIN empresa_obrigacoes eo
                  ON eo.modelo_id = m.id AND eo.empresa_id = $1
          WHERE m.ativo ORDER BY m.nome`, [empresaId]),
      db.query(
        `SELECT o.*, u.nome AS responsavel
           FROM obrigacoes o LEFT JOIN usuarios u ON u.id = o.responsavel_id
          WHERE o.empresa_id = $1
          ORDER BY o.vencimento DESC LIMIT 60`, [empresaId]),
      obrigacoes.resumoPorEmpresa(empresaId)
    ]);
    res.json({ modelos: vinculos.rows, ocorrencias: lista.rows, resumo });
  } catch (e) { next(e); }
});

/* Liga ou desliga uma obrigação para o cliente. */
router.put('/empresa/:id/modelo/:modeloId', somenteAdmin, async (req, res, next) => {
  try {
    const empresaId = Number(req.params.id);
    if (!empresaVisivel(req, empresaId)) {
      return res.status(404).json({ erro: 'Empresa não encontrada' });
    }
    const ativo = (req.body || {}).ativo !== false;
    await db.query(
      `INSERT INTO empresa_obrigacoes (empresa_id, modelo_id, ativo)
       VALUES ($1,$2,$3)
       ON CONFLICT (empresa_id, modelo_id) DO UPDATE SET ativo = EXCLUDED.ativo`,
      [empresaId, req.params.modeloId, ativo]);

    // Ligar já cria as próximas ocorrências: sem isso a obrigação existiria no
    // cadastro sem aparecer na agenda até a próxima geração automática.
    if (ativo) await obrigacoes.gerar({ empresaId, meses: 3 });

    const m = await db.query('SELECT nome FROM obrigacao_modelos WHERE id = $1', [req.params.modeloId]);
    await auditoria.registrar(req, empresaId, 'obrigacao.vinculo',
      (ativo ? 'Passou a acompanhar' : 'Deixou de acompanhar') + ' "' +
      (m.rows[0] ? m.rows[0].nome : 'obrigação') + '"');

    res.json({ ok: true, ativo });
  } catch (e) { next(e); }
});

/* --------------------------------------------------------- ocorrências */

router.put('/:id', async (req, res, next) => {
  try {
    const b = req.body || {};
    const atual = await db.query('SELECT * FROM obrigacoes WHERE id = $1', [req.params.id]);
    if (!atual.rows.length) return res.status(404).json({ erro: 'Obrigação não encontrada' });
    if (!empresaVisivel(req, atual.rows[0].empresa_id)) {
      return res.status(404).json({ erro: 'Obrigação não encontrada' });
    }

    const situacoes = ['pendente', 'concluida', 'dispensada'];
    if (b.situacao && !situacoes.includes(b.situacao)) {
      return res.status(400).json({ erro: 'Situação inválida.' });
    }

    const concluindo = b.situacao === 'concluida' && atual.rows[0].situacao !== 'concluida';
    const quem = auditoria.autorDe(req);

    const r = await db.query(
      `UPDATE obrigacoes SET
         situacao       = COALESCE($2, situacao),
         observacao     = COALESCE($3, observacao),
         responsavel_id = COALESCE($4, responsavel_id),
         vencimento     = COALESCE($5::date, vencimento),
         concluida_em   = CASE WHEN $2 = 'concluida' THEN now()
                               WHEN $2 = 'pendente'  THEN NULL
                               ELSE concluida_em END,
         concluida_por  = CASE WHEN $2 = 'concluida' THEN $6
                               WHEN $2 = 'pendente'  THEN NULL
                               ELSE concluida_por END
       WHERE id = $1 RETURNING *`,
      [req.params.id, b.situacao ?? null, b.observacao ?? null,
       b.responsavelId ?? null, b.vencimento ?? null, quem.autor]);

    if (concluindo) {
      await auditoria.registrar(req, atual.rows[0].empresa_id, 'obrigacao.concluida',
        'Concluiu "' + atual.rows[0].nome + '" da competência ' + atual.rows[0].competencia,
        { referencia: atual.rows[0].competencia });
    }
    res.json(r.rows[0]);
  } catch (e) { next(e); }
});

/* Gera as ocorrências futuras. Roda sozinho na subida; o botão existe para
   quando o escritório acabou de cadastrar e quer ver na hora. */
router.post('/gerar', somenteAdmin, async (req, res, next) => {
  try {
    res.json(await obrigacoes.gerar({ meses: Math.min(Number((req.body || {}).meses) || 3, 12) }));
  } catch (e) { next(e); }
});

module.exports = router;
