const express = require('express');
const servico = require('../services/notasEntrada');
const auditoria = require('../services/auditoria');
const { empresasVisiveis, somenteAdmin } = require('../middleware/escopo');

const router = express.Router();

/* As notas que a empresa recebe.
 *
 * TODA rota daqui passa por `empresasVisiveis`. Uma nota de entrada diz quanto
 * um cliente do escritório pagou a quem — é exatamente o tipo de dado que não
 * pode vazar de um cliente para outro. `null` significa "enxerga tudo" e só
 * acontece para administrador; lista vazia significa "nenhuma", e as duas
 * coisas precisam continuar distintas.
 */

router.get('/', async (req, res, next) => {
  try {
    res.json(await servico.buscar(req.query, empresasVisiveis(req)));
  } catch (e) { next(e); }
});

router.get('/fornecedores', async (req, res, next) => {
  try {
    res.json(await servico.fornecedores(empresasVisiveis(req)));
  } catch (e) { next(e); }
});

router.get('/:id/xml', async (req, res, next) => {
  try {
    const n = await servico.xmlDe(req.params.id, empresasVisiveis(req));
    /* Fora do escopo devolve 404, não 403: para quem chamou, a nota de outro
       cliente simplesmente não existe — dizer "existe, mas você não pode"
       já entrega que ela existe. */
    if (!n) return res.status(404).json({ erro: 'Nota não encontrada' });
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Content-Disposition',
      'attachment; filename="' + n.chave_acesso + '.xml"');
    res.send(n.xml);
  } catch (e) { next(e); }
});

/* Importar é do administrador. Quem manda XML define o que entra na apuração
   dos clientes, e a empresa dona sai do próprio arquivo — mas a decisão de
   alimentar a base é de quem administra. */
router.post('/importar', somenteAdmin, async (req, res, next) => {
  try {
    const arquivos = (req.body || {}).arquivos;
    if (!Array.isArray(arquivos) || !arquivos.length) {
      return res.status(400).json({ erro: 'Mande ao menos um arquivo XML.' });
    }
    const r = await servico.importar(arquivos);
    await auditoria.registrar(req, null, 'notas_entrada.importar',
      'Importou notas de entrada: ' + r.novas + ' nova(s), ' +
      r.repetidas + ' repetida(s), ' + r.recusadas + ' recusada(s)');
    res.json(r);
  } catch (e) { next(e); }
});

router.post('/importar-pasta', somenteAdmin, async (req, res, next) => {
  try {
    const caminho = (req.body || {}).caminho;
    if (!caminho) return res.status(400).json({ erro: 'Diga o caminho da pasta.' });
    const r = await servico.importarPasta(String(caminho));
    await auditoria.registrar(req, null, 'notas_entrada.importar',
      'Importou a pasta ' + caminho + ': ' + r.novas + ' nova(s), ' +
      r.repetidas + ' repetida(s), ' + r.recusadas + ' recusada(s)');
    res.json(r);
  } catch (e) {
    res.status(e.status || 500).json({ erro: e.message });
  }
});

module.exports = router;
