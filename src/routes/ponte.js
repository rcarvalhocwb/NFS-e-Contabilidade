const express = require('express');
const db = require('../db');
const ponte = require('../services/ponteNuvem');
const repassador = require('../services/repassadorLocal');
const auditoria = require('../services/auditoria');
const { somenteAdmin, empresasVisiveis, empresaVisivel } = require('../middleware/escopo');

const router = express.Router();

/* ------------------------------------------------------------ configuração */

router.get('/config', somenteAdmin, async (_req, res, next) => {
  try {
    res.json(await ponte.ler());
  } catch (e) { next(e); }
});

router.put('/config', somenteAdmin, async (req, res, next) => {
  try {
    const antes = await ponte.ler();
    const salvo = await ponte.salvar(req.body || {});
    await auditoria.registrar(req, null, 'ponte.config',
      'Alterou a ligação com o portal do cliente',
      { detalhe: { url: salvo.url, ativo: salvo.ativo,
                   automatico: salvo.emitir_automatico,
                   repassadorLocal: salvo.relay_local } });

    /* Mexeu no repassador desta máquina: aplica agora.
       Salvar na tela e o processo continuar com a configuração velha até
       alguém reiniciar o gateway é a pior forma de errar — parece feito. */
    const b = req.body || {};
    const mudou = antes.relay_local !== salvo.relay_local ||
                  antes.relay_porta !== salvo.relay_porta ||
                  antes.tunel_ativo !== salvo.tunel_ativo ||
                  antes.tunel_binario !== salvo.tunel_binario ||
                  b.waAppSecret || b.waVerifyToken || b.waToken || b.tunelToken;
    if (mudou) {
      const r = await repassador.reaplicar();
      return res.json(Object.assign({}, salvo, { repassador: r }));
    }
    res.json(salvo);
  } catch (e) { next(e); }
});

/* Como está o repassador desta máquina — de pé, caído, ou nunca subiu e por
   quê. É a primeira pergunta quando o bot não responde. */
router.get('/repassador', somenteAdmin, async (_req, res, next) => {
  try { res.json(await repassador.situacao()); }
  catch (e) { next(e); }
});

/* Reinicia à mão. Serve para depois de trocar o token na Meta e para o caso em
   que o processo caiu cinco vezes e a supervisão desistiu de propósito. */
router.post('/repassador/reiniciar', somenteAdmin, async (req, res, next) => {
  try {
    const r = await repassador.reaplicar();
    await auditoria.registrar(req, null, 'ponte.repassador',
      'Reiniciou o repassador do WhatsApp nesta máquina');
    res.json(r);
  } catch (e) { next(e); }
});

/* Roda uma sincronização agora, sem esperar o intervalo. É como se confere que
   a ligação funciona: erro de chave ou de endereço aparece aqui, e não numa
   solicitação de cliente que ninguém sabe que existiu. */
router.post('/sincronizar', somenteAdmin, async (req, res, next) => {
  try {
    const r = await ponte.sincronizar({ forcar: true });
    await auditoria.registrar(req, null, 'ponte.sincronizou',
      'Buscou solicitações no portal: ' + JSON.stringify(r));
    res.json(r);
  } catch (e) {
    // Portal fora do ar não é erro do gateway: devolve o motivo, não um 500
    res.status(e.status || 502).json({ erro: e.message });
  }
});

/* Manda o cadastro agora, mesmo sem mudança. Serve para conferir a ligação e
   para depois de o portal ser restaurado de um backup velho. */
router.post('/cadastro', somenteAdmin, async (req, res, next) => {
  try {
    const r = await require('../services/replicaCadastro').enviar({ forcar: true });
    await auditoria.registrar(req, null, 'ponte.cadastro',
      'Enviou o cadastro ao portal: ' + JSON.stringify(r));
    res.json(r);
  } catch (e) {
    res.status(e.status || 502).json({ erro: e.message });
  }
});

/* O retrato exatamente como o portal vai recebê-lo. Existe para conferir o que
   sai daqui antes de ligar a réplica — e para provar que certificado e senha
   não estão nele. */
router.get('/cadastro/previa', somenteAdmin, async (_req, res, next) => {
  try { res.json(await require('../services/replicaCadastro').montar()); }
  catch (e) { next(e); }
});

/* O que falta para o WhatsApp funcionar.
 *
 * "Não funciona" tem umas quinze causas possíveis — token vencido, campo
 * `messages` não assinado, empresa não liberada, cadastro nunca enviado.
 * Descobrir qual delas é, um palpite por vez, custa uma tarde. Esta rota
 * percorre a corrente e devolve a lista do que está de pé e do que falta.
 */
router.get('/diagnostico', somenteAdmin, async (_req, res, next) => {
  try {
    res.json(await require('../services/diagnosticoWhatsapp').conferir());
  } catch (e) { next(e); }
});

/* ----------------------------------------------------------- solicitações */

router.get('/solicitacoes', async (req, res, next) => {
  try {
    const ids = empresasVisiveis(req);
    const params = [];
    let filtro = '';
    if (ids !== null) {
      params.push(ids);
      filtro += ` AND s.empresa_id = ANY($${params.length}::int[])`;
    }
    if (req.query.situacao) {
      params.push(req.query.situacao);
      filtro += ` AND s.situacao = $${params.length}`;
    }
    params.push(Math.min(Number(req.query.limite) || 50, 200));

    const r = await db.query(
      `SELECT s.id, s.id_externo, s.cnpj_informado, s.situacao, s.motivo,
              s.decidido_por, s.decidido_em, s.recebida_em, s.devolvida_em,
              s.payload, s.origem, s.remetente, s.transcricao,
              e.razao_social, n.chave_acesso, n.serie, n.numero,
              n.status AS status_nota
         FROM solicitacoes s
         LEFT JOIN empresas e ON e.id = s.empresa_id
         LEFT JOIN notas n ON n.id = s.nota_id
        WHERE 1=1${filtro}
        ORDER BY s.recebida_em DESC LIMIT $${params.length}`, params);
    res.json(r.rows);
  } catch (e) { next(e); }
});

/* Aprova e emite. A aprovação é do contador: uma solicitação vinda da internet
   vira documento fiscal com imposto, e isso não se decide sozinho por padrão. */
router.post('/solicitacoes/:id/aprovar', async (req, res, next) => {
  try {
    const r = await db.query('SELECT * FROM solicitacoes WHERE id = $1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ erro: 'Solicitação não encontrada' });
    const s = r.rows[0];

    /* Chegou com CNPJ que o escritório ainda não atendia: procura de novo.
       O caminho normal é justamente esse — o contador vê "CNPJ não cadastrado",
       cadastra a empresa e volta aqui. Sem reprocurar, "Tentar de novo" nunca
       daria certo por mais que a empresa fosse cadastrada. */
    if (!s.empresa_id && s.cnpj_informado) {
      const achou = await db.query(
        'SELECT id FROM empresas WHERE cnpj = $1 AND ativo', [s.cnpj_informado]);
      if (achou.rows.length) {
        s.empresa_id = achou.rows[0].id;
        await db.query('UPDATE solicitacoes SET empresa_id = $2 WHERE id = $1',
          [s.id, s.empresa_id]);
      }
    }
    if (!s.empresa_id) {
      return res.status(422).json({
        erro: 'Nenhuma empresa ativa com o CNPJ ' + (s.cnpj_informado || '(não informado)') +
              '. Cadastre a empresa e tente de novo.'
      });
    }

    if (!empresaVisivel(req, s.empresa_id)) {
      return res.status(404).json({ erro: 'Solicitação não encontrada' });
    }
    if (s.situacao === 'emitida') {
      return res.status(409).json({ erro: 'Esta solicitação já virou nota.' });
    }

    const quem = auditoria.autorDe(req);
    await db.query(
      `UPDATE solicitacoes SET situacao = 'aprovada', decidido_por = $2, decidido_em = now()
        WHERE id = $1`, [s.id, quem.autor]);

    const saida = await ponte.emitirSolicitacao(s, {
      usuarioId: req.auth.tipo === 'usuario' ? req.auth.usuarioId : null
    });

    await auditoria.registrar(req, s.empresa_id, 'solicitacao.aprovada',
      'Aprovou a solicitação ' + s.id_externo + (saida.ok ? '' : ' — a emissão falhou'),
      { referencia: s.id_externo, detalhe: { notaId: saida.notaId, erro: saida.erro } });

    res.status(saida.ok ? 202 : 422).json(saida);
  } catch (e) { next(e); }
});

router.post('/solicitacoes/:id/recusar', async (req, res, next) => {
  try {
    const motivo = (req.body || {}).motivo;
    if (!motivo) {
      return res.status(400).json({
        erro: 'Diga por que está recusando — o motivo volta para o cliente no portal.'
      });
    }
    const r = await db.query('SELECT * FROM solicitacoes WHERE id = $1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ erro: 'Solicitação não encontrada' });
    const s = r.rows[0];
    if (!empresaVisivel(req, s.empresa_id)) {
      return res.status(404).json({ erro: 'Solicitação não encontrada' });
    }
    if (s.situacao === 'emitida') {
      return res.status(409).json({ erro: 'Esta solicitação já virou nota; use o cancelamento.' });
    }

    const quem = auditoria.autorDe(req);
    await db.query(
      `UPDATE solicitacoes SET situacao = 'recusada', motivo = $2,
              decidido_por = $3, decidido_em = now(), devolvida_em = NULL
        WHERE id = $1`, [s.id, motivo, quem.autor]);

    await auditoria.registrar(req, s.empresa_id, 'solicitacao.recusada',
      'Recusou a solicitação ' + s.id_externo + ' — ' + motivo,
      { referencia: s.id_externo });

    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
