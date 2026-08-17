const express = require('express');
const db = require('../db');
const { emitir, consultar, cancelar } = require('../services/emissaoService');
const { criarZip } = require('../util/zip');
const { notaNoEscopo, filtroSqlEmpresas, empresaVisivel } = require('../middleware/escopo');
const { validarDocumento } = require('../util/documento');
const { gerarDanfse } = require('../nfse/danfse');

const router = express.Router();

/* Emitir NFS-e.
   Body: { cnpjEmpresa, dataCompetencia, tomador{...}, servico{...}, valores{...} } */
router.post('/', async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.cnpjEmpresa) return res.status(400).json({ erro: 'cnpjEmpresa é obrigatório' });
    if (!b.servico || !b.servico.codigoTributacaoNacional || !b.servico.descricao) {
      return res.status(400).json({ erro: 'servico.codigoTributacaoNacional e servico.descricao são obrigatórios' });
    }
    if (!b.valores || b.valores.valorServico === undefined) {
      return res.status(400).json({ erro: 'valores.valorServico é obrigatório' });
    }
    if (b.referencia !== undefined && !/^[\w.:-]{1,100}$/.test(String(b.referencia))) {
      return res.status(400).json({ erro: 'referencia deve ter até 100 caracteres (letras, números, . : _ -)' });
    }
    // Documento do tomador conferido aqui: se estiver errado, a Sefin recusa
    // (E0188) só depois de reservarmos número e assinarmos a DPS — deixando um
    // buraco na numeração fiscal por um erro de digitação.
    const docTomador = b.tomador && (b.tomador.cnpj || b.tomador.cpf);
    if (docTomador && !validarDocumento(docTomador)) {
      return res.status(400).json({
        erro: `Documento do tomador inválido (dígito verificador não confere): ${docTomador}`
      });
    }
    if (b.substituicao) {
      const ch = String(b.substituicao.chaveSubstituida || '').replace(/\D/g, '');
      if (ch.length !== 50) {
        return res.status(400).json({ erro: 'substituicao.chaveSubstituida deve ter 50 dígitos' });
      }
      if (String(b.substituicao.codigoMotivo) === '99' && !b.substituicao.motivo) {
        return res.status(400).json({ erro: 'substituicao.motivo é obrigatório quando codigoMotivo = 99 (Outros)' });
      }
    }
    // Escopo: um operador não emite por empresa que não enxerga. A checagem
    // vem antes de emitir() para não reservar número numa empresa alheia.
    const emp = await db.query('SELECT id FROM empresas WHERE cnpj = $1',
      [String(b.cnpjEmpresa).replace(/\D/g, '')]);
    if (!emp.rows.length || !empresaVisivel(req, emp.rows[0].id)) {
      return res.status(404).json({ erro: 'Empresa não encontrada' });
    }

    const resultado = await emitir(b.cnpjEmpresa, b, {
      // Quem emitiu: fica registrado só quando foi uma pessoa. Emissão por
      // integração responde pelo token da empresa, não por um usuário.
      usuarioId: req.auth.tipo === 'usuario' ? req.auth.usuarioId : null
    });
    // 200 quando a referência já existia (nada foi criado agora);
    // 202 quando a nota entrou na fila e será transmitida pelo worker.
    res.status(resultado.idempotente ? 200 : 202).json(resultado);
  } catch (e) { next(e); }
});

/* Listar notas locais (filtros: cnpjEmpresa, status, limite) */
router.get('/', async (req, res, next) => {
  try {
    const params = [];
    let where = '1=1';
    if (req.query.cnpjEmpresa) {
      params.push(String(req.query.cnpjEmpresa).replace(/\D/g, ''));
      where += ` AND e.cnpj = $${params.length}`;
    }
    if (req.query.status) {
      params.push(req.query.status);
      where += ` AND n.status = $${params.length}`;
    }
    if (req.query.ambiente) {
      params.push(req.query.ambiente);
      where += ` AND n.ambiente = $${params.length}`;
    }
    if (req.query.referencia) {
      params.push(req.query.referencia);
      where += ` AND n.referencia = $${params.length}`;
    }
    // Escopo do usuário/token: não basta filtrar no painel, a consulta não pode
    // trazer nota de empresa que quem pediu não enxerga.
    const escopo = filtroSqlEmpresas(req, 'n.empresa_id', params.length);
    where += escopo.sql;
    params.push(...escopo.params);

    params.push(Math.min(parseInt(req.query.limite || '50', 10), 500));
    const r = await db.query(
      `SELECT n.id, e.cnpj AS cnpj_empresa, n.id_dps, n.chave_acesso, n.serie, n.numero,
              n.referencia, n.ambiente, n.tentativas, n.ultimo_erro, n.processar_apos,
              n.status, n.mensagens, n.criado_em, n.atualizado_em
       FROM notas n JOIN empresas e ON e.id = n.empresa_id
       WHERE ${where} ORDER BY n.id DESC LIMIT $${params.length}`,
      params
    );
    res.json(r.rows);
  } catch (e) { next(e); }
});

/* Exportar XMLs em .zip por período.
   Query: cnpjEmpresa? status? ambiente? tipo=nfse|dps (padrão nfse)
          inicio=YYYY-MM-DD  fim=YYYY-MM-DD (por data de criação)
   Sem período, exporta tudo que casar com os filtros (até o limite). */
router.get('/export', async (req, res, next) => {
  try {
    const tipo = req.query.tipo === 'dps' ? 'dps' : 'nfse';
    const coluna = tipo === 'dps' ? 'dps_xml' : 'nfse_xml';

    const params = [];
    let where = `n.${coluna} IS NOT NULL`;
    if (req.query.cnpjEmpresa) {
      params.push(String(req.query.cnpjEmpresa).replace(/\D/g, ''));
      where += ` AND e.cnpj = $${params.length}`;
    }
    if (req.query.status) { params.push(req.query.status); where += ` AND n.status = $${params.length}`; }
    if (req.query.ambiente) { params.push(req.query.ambiente); where += ` AND n.ambiente = $${params.length}`; }
    if (req.query.inicio) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(req.query.inicio)) return res.status(400).json({ erro: 'inicio deve ser YYYY-MM-DD' });
      params.push(req.query.inicio); where += ` AND n.criado_em >= $${params.length}::date`;
    }
    if (req.query.fim) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(req.query.fim)) return res.status(400).json({ erro: 'fim deve ser YYYY-MM-DD' });
      // < fim+1 dia para incluir o dia inteiro do "fim"
      params.push(req.query.fim); where += ` AND n.criado_em < ($${params.length}::date + interval '1 day')`;
    }
    const escopo = filtroSqlEmpresas(req, 'n.empresa_id', params.length);
    where += escopo.sql;
    params.push(...escopo.params);

    params.push(Math.min(parseInt(req.query.limite || '1000', 10), 5000));

    const r = await db.query(
      `SELECT n.id, n.chave_acesso, n.id_dps, n.${coluna} AS xml
       FROM notas n JOIN empresas e ON e.id = n.empresa_id
       WHERE ${where} ORDER BY n.id LIMIT $${params.length}`, params);

    if (!r.rows.length) return res.status(404).json({ erro: 'Nenhuma nota com XML para os filtros informados' });

    const arquivos = r.rows.map(row => ({
      // chave de acesso é o nome natural; sem ela (DPS/rejeitada) usa id_dps
      nome: `${tipo}-${row.chave_acesso || row.id_dps || row.id}.xml`,
      conteudo: row.xml
    }));
    const zip = criarZip(arquivos);

    const nomeZip = `${tipo}-${new Date().toISOString().slice(0, 10)}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${nomeZip}"`);
    res.setHeader('X-Total-Xmls', String(arquivos.length));
    res.send(zip);
  } catch (e) { next(e); }
});

/* Detalhar nota local (inclui XMLs) */
router.get('/local/:id', async (req, res, next) => {
  try {
    const r = await db.query(
      `SELECT n.*, e.cnpj AS cnpj_empresa FROM notas n
       JOIN empresas e ON e.id = n.empresa_id WHERE n.id = $1`,
      [req.params.id]
    );
    // Fora do escopo do token = inexistente, para não revelar notas de outra
    // empresa do grupo.
    if (!r.rows.length || !notaNoEscopo(req, r.rows[0])) {
      return res.status(404).json({ erro: 'Nota não encontrada' });
    }
    res.json(r.rows[0]);
  } catch (e) { next(e); }
});

/* Busca a nota por id local OU por chave de acesso — os sistemas conectados
   costumam ter só a chave, enquanto o painel tem o id. */
async function acharNota(idOuChave, req) {
  const campo = /^\d{1,9}$/.test(String(idOuChave)) ? 'n.id = $1' : 'n.chave_acesso = $1';
  const r = await db.query(
    `SELECT n.*, e.cnpj AS cnpj_empresa, e.razao_social FROM notas n
     JOIN empresas e ON e.id = n.empresa_id WHERE ${campo}`, [idOuChave]);
  const nota = r.rows[0] || null;
  // Nota de outra empresa é tratada como inexistente para o token do cliente.
  if (nota && req && !notaNoEscopo(req, nota)) return null;
  return nota;
}

/* XML da NFS-e autorizada — é o documento com valor fiscal.
   É o mesmo XML assinado pela Sefin, para o sistema conectado arquivar. */
router.get('/:idOuChave/xml', async (req, res, next) => {
  try {
    const nota = await acharNota(req.params.idOuChave, req);
    if (!nota) return res.status(404).json({ erro: 'Nota não encontrada' });
    if (!nota.nfse_xml) {
      return res.status(409).json({
        erro: `Nota sem XML de NFS-e (status: ${nota.status}). O XML só existe após a autorização.`,
        status: nota.status
      });
    }
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Content-Disposition',
      `attachment; filename="${nota.chave_acesso || nota.id_dps}.xml"`);
    res.send(nota.nfse_xml);
  } catch (e) { next(e); }
});

/* XML da DPS assinada — útil para auditoria do que foi transmitido. */
router.get('/:idOuChave/xml-dps', async (req, res, next) => {
  try {
    const nota = await acharNota(req.params.idOuChave, req);
    if (!nota) return res.status(404).json({ erro: 'Nota não encontrada' });
    if (!nota.dps_xml) return res.status(409).json({ erro: 'Nota sem DPS gravada' });
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="DPS-${nota.id_dps}.xml"`);
    res.send(nota.dps_xml);
  } catch (e) { next(e); }
});

/* DANFSe em PDF, gerado localmente a partir do XML autorizado.
   A API oficial (GET /danfse/{chave}) responde 501 — foi descontinuada —
   então o gateway monta o documento auxiliar por conta própria. */
router.get('/:idOuChave/danfse', async (req, res, next) => {
  try {
    const nota = await acharNota(req.params.idOuChave, req);
    if (!nota) return res.status(404).json({ erro: 'Nota não encontrada' });
    if (!nota.nfse_xml) {
      return res.status(409).json({
        erro: `Nota sem NFS-e autorizada (status: ${nota.status}). O DANFSe só existe após a autorização.`,
        status: nota.status
      });
    }
    const pdf = await gerarDanfse(nota.nfse_xml);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition',
      `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="DANFSe-${nota.chave_acesso}.pdf"`);
    res.send(pdf);
  } catch (e) { next(e); }
});

/* Consultar NFS-e na Sefin Nacional pela chave de acesso */
router.get('/:chaveAcesso', async (req, res, next) => {
  try {
    const cnpjEmpresa = req.query.cnpjEmpresa;
    if (!cnpjEmpresa) return res.status(400).json({ erro: 'Informe ?cnpjEmpresa= (certificado usado na consulta)' });
    res.json(await consultar(cnpjEmpresa, req.params.chaveAcesso));
  } catch (e) { next(e); }
});

/* Cancelar NFS-e.
   Body: { cnpjEmpresa, codigoMotivo (1=erro emissão, 2=serviço não prestado, 9=outros), motivo } */
router.post('/:chaveAcesso/cancelamento', async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.cnpjEmpresa) return res.status(400).json({ erro: 'cnpjEmpresa é obrigatório' });
    // A Sefin exige xMotivo em qualquer código; o builder preenche um texto
    // padrão quando não vem informado. Para "Outros" o texto próprio é
    // obrigatório — o padrão genérico não descreve nada.
    if (Number(b.codigoMotivo) === 9 && !b.motivo) {
      return res.status(400).json({ erro: 'motivo é obrigatório quando codigoMotivo = 9 (Outros)' });
    }
    const resultado = await cancelar(b.cnpjEmpresa, req.params.chaveAcesso, b);
    res.status(resultado.cancelada ? 200 : 422).json(resultado);
  } catch (e) { next(e); }
});

module.exports = router;
