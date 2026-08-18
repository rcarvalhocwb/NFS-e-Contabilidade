const express = require('express');
const multer = require('multer');
const db = require('../db');
const { emitir } = require('../services/emissaoService');
const { lerCsv, lerNumero, gerarCsv } = require('../util/csv');
const { validarDocumento, limparDocumento } = require('../util/documento');
const { empresaVisivel, empresasVisiveis } = require('../middleware/escopo');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

/* Colunas aceitas na planilha. Vários nomes para a mesma coisa: quem monta o
   arquivo não deveria ter de decorar a grafia exata. */
const COLUNAS = {
  documento: ['documento', 'cnpj', 'cpf', 'cnpjcpf', 'cpfcnpj', 'documentocliente', 'cnpjdocliente'],
  razaoSocial: ['razaosocial', 'nome', 'cliente', 'nomecliente'],
  codigoMunicipio: ['codigomunicipio', 'municipio', 'ibge', 'codigoibge', 'codmunicipio'],
  email: ['email', 'emailcliente'],
  telefone: ['telefone', 'fone', 'celular'],
  codigoTributacao: ['codigotributacao', 'codigoservico', 'ctribnac', 'codigo', 'servico'],
  descricao: ['descricao', 'descricaoservico', 'discriminacao'],
  valor: ['valor', 'valorservico', 'valortotal', 'total'],
  aliquota: ['aliquota', 'aliquotaiss', 'iss'],
  issRetido: ['issretido', 'retido'],
  referencia: ['referencia', 'ref', 'numeropedido', 'pedido'],
  observacoes: ['observacoes', 'obs', 'informacoescomplementares', 'complemento'],
  competencia: ['competencia', 'datacompetencia']
};

/* Acha o valor da coluna, aceitando qualquer um dos apelidos. */
function campo(registro, nome) {
  for (const apelido of COLUNAS[nome]) {
    if (registro[apelido] !== undefined && registro[apelido] !== '') return registro[apelido];
  }
  return undefined;
}

function simNao(v) {
  if (v === undefined) return false;
  return /^(s|sim|1|true|x)$/i.test(String(v).trim());
}

/* Converte uma linha da planilha no corpo que a emissão espera, devolvendo o
   problema em vez de lançar: uma linha ruim não pode derrubar o lote inteiro. */
function montarNota(registro, empresa) {
  const doc = limparDocumento(campo(registro, 'documento'));
  const valor = lerNumero(campo(registro, 'valor'));
  const codigo = String(campo(registro, 'codigoTributacao') || '').replace(/\D/g, '');
  const descricao = campo(registro, 'descricao');

  const problemas = [];
  if (!codigo || codigo.length !== 6) problemas.push('código de tributação deve ter 6 dígitos');
  if (!descricao) problemas.push('descrição do serviço vazia');
  if (valor === undefined || valor <= 0) problemas.push('valor inválido');
  if (doc && !validarDocumento(doc)) problemas.push('documento do cliente inválido (' + doc + ')');
  if (doc && !campo(registro, 'razaoSocial')) problemas.push('nome do cliente vazio');
  if (problemas.length) return { erro: problemas.join('; ') };

  const optanteSN = [2, 3].includes(Number(empresa.op_simp_nac));
  const aliquota = lerNumero(campo(registro, 'aliquota'));

  const nota = {
    cnpjEmpresa: empresa.cnpj,
    servico: {
      codigoTributacaoNacional: codigo,
      descricao: String(descricao),
      informacoesComplementares: campo(registro, 'observacoes')
    },
    valores: {
      valorServico: valor,
      issRetido: simNao(campo(registro, 'issRetido'))
    }
  };
  // Optante do Simples não declara alíquota de ISS
  if (!optanteSN && aliquota !== undefined) nota.valores.aliquotaIss = aliquota;

  const competencia = campo(registro, 'competencia');
  if (competencia) {
    // dd/mm/aaaa é o que sai do Excel brasileiro
    const br = String(competencia).match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    nota.dataCompetencia = br ? br[3] + '-' + br[2] + '-' + br[1] : String(competencia);
  }
  const referencia = campo(registro, 'referencia');
  if (referencia) nota.referencia = String(referencia).replace(/[^\w.:-]/g, '-').slice(0, 100);

  if (doc) {
    nota.tomador = {};
    if (doc.length === 14) nota.tomador.cnpj = doc; else nota.tomador.cpf = doc;
    nota.tomador.razaoSocial = String(campo(registro, 'razaoSocial'));
    nota.tomador.email = campo(registro, 'email');
    nota.tomador.telefone = campo(registro, 'telefone');
    const mun = String(campo(registro, 'codigoMunicipio') || '').replace(/\D/g, '');
    if (mun) nota.tomador.endereco = { codigoMunicipio: mun };
  }
  return { nota };
}

/* Modelo de planilha para baixar e preencher. */
router.get('/modelo', (_req, res) => {
  const csv = gerarCsv(
    [
      { titulo: 'documento', campo: 'documento' },
      { titulo: 'razao_social', campo: 'razaoSocial' },
      { titulo: 'codigo_municipio', campo: 'codigoMunicipio' },
      { titulo: 'email', campo: 'email' },
      { titulo: 'codigo_tributacao', campo: 'codigoTributacao' },
      { titulo: 'descricao', campo: 'descricao' },
      { titulo: 'valor', campo: 'valor' },
      { titulo: 'aliquota', campo: 'aliquota' },
      { titulo: 'iss_retido', campo: 'issRetido' },
      { titulo: 'referencia', campo: 'referencia' },
      { titulo: 'observacoes', campo: 'observacoes' }
    ],
    [
      { documento: '14073521000183', razaoSocial: 'CLIENTE EXEMPLO LTDA',
        codigoMunicipio: '4106902', email: 'contato@cliente.com.br',
        codigoTributacao: '110201', descricao: 'Servico prestado em agosto',
        valor: '1500,00', aliquota: '5', issRetido: 'nao',
        referencia: 'AGO-2026-001', observacoes: 'Contrato 123' }
    ]);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="modelo-lote-nfse.csv"');
  res.send(csv);
});

/* Confere a planilha sem emitir nada.
   Sempre vale conferir antes: uma vez emitida, a nota só sai por cancelamento,
   e cada erro custa um número da sequência fiscal. */
router.post('/conferir', upload.single('arquivo'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ erro: 'Envie a planilha no campo "arquivo"' });
    const empresaId = Number(req.body.empresaId);
    if (!empresaVisivel(req, empresaId)) return res.status(404).json({ erro: 'Empresa não encontrada' });

    const emp = await db.query('SELECT * FROM empresas WHERE id = $1', [empresaId]);
    if (!emp.rows.length) return res.status(404).json({ erro: 'Empresa não encontrada' });

    const { registros } = lerCsv(req.file.buffer.toString('utf8'));
    if (!registros.length) return res.status(400).json({ erro: 'A planilha não tem linhas de dados' });

    let totalValor = 0;
    const itens = registros.map(r => {
      const { nota, erro } = montarNota(r, emp.rows[0]);
      if (nota) totalValor += nota.valores.valorServico;
      return {
        linha: r.__linha,
        cliente: campo(r, 'razaoSocial') || '(sem tomador)',
        documento: campo(r, 'documento') || '',
        descricao: campo(r, 'descricao') || '',
        valor: nota ? nota.valores.valorServico : lerNumero(campo(r, 'valor')),
        erro: erro || null
      };
    });

    res.json({
      empresa: { cnpj: emp.rows[0].cnpj, razaoSocial: emp.rows[0].razao_social,
                 ambiente: emp.rows[0].ambiente },
      total: itens.length,
      validos: itens.filter(i => !i.erro).length,
      comErro: itens.filter(i => i.erro).length,
      valorTotal: totalValor,
      itens
    });
  } catch (e) { next(e); }
});

/* Emite o lote. Só as linhas sem erro entram; as demais ficam registradas para
   correção, sem impedir o resto. */
router.post('/', upload.single('arquivo'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ erro: 'Envie a planilha no campo "arquivo"' });
    const empresaId = Number(req.body.empresaId);
    if (!empresaVisivel(req, empresaId)) return res.status(404).json({ erro: 'Empresa não encontrada' });

    const emp = await db.query('SELECT * FROM empresas WHERE id = $1 AND ativo', [empresaId]);
    if (!emp.rows.length) return res.status(404).json({ erro: 'Empresa não encontrada ou inativa' });
    const empresa = emp.rows[0];

    const { registros } = lerCsv(req.file.buffer.toString('utf8'));
    if (!registros.length) return res.status(400).json({ erro: 'A planilha não tem linhas de dados' });

    const lote = await db.query(
      `INSERT INTO lotes (empresa_id, usuario_id, descricao, ambiente, total)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [empresa.id, req.auth.tipo === 'usuario' ? req.auth.usuarioId : null,
       req.body.descricao || req.file.originalname, empresa.ambiente, registros.length]);
    const loteId = lote.rows[0].id;

    /* Sequencial, não em paralelo: a numeração da DPS é uma sequência, e
       disparar tudo de uma vez só aumentaria a disputa pelo mesmo lock. */
    let enviados = 0, comErro = 0;
    for (const registro of registros) {
      const { nota, erro } = montarNota(registro, empresa);

      if (erro) {
        await db.query(
          `INSERT INTO lote_itens (lote_id, linha, dados, status, erro)
           VALUES ($1,$2,$3,'erro',$4)`,
          [loteId, registro.__linha, JSON.stringify(registro), erro]);
        comErro++;
        continue;
      }
      try {
        const r = await emitir(empresa.cnpj, nota, {
          usuarioId: req.auth.tipo === 'usuario' ? req.auth.usuarioId : null
        });
        await db.query(
          `INSERT INTO lote_itens (lote_id, linha, dados, nota_id, status)
           VALUES ($1,$2,$3,$4,'enviado')`,
          [loteId, registro.__linha, JSON.stringify(registro), r.notaId]);
        enviados++;
      } catch (e) {
        await db.query(
          `INSERT INTO lote_itens (lote_id, linha, dados, status, erro)
           VALUES ($1,$2,$3,'erro',$4)`,
          [loteId, registro.__linha, JSON.stringify(registro), e.message]);
        comErro++;
      }
    }

    res.status(202).json({
      loteId, total: registros.length, enviados, comErro,
      aviso: 'As notas entraram na fila. Acompanhe o resultado no lote.'
    });
  } catch (e) { next(e); }
});

/* Lista os lotes das empresas visíveis. */
router.get('/', async (req, res, next) => {
  try {
    const ids = empresasVisiveis(req);
    const r = await db.query(
      `SELECT l.id, l.descricao, l.ambiente, l.total, l.criado_em,
              e.cnpj, e.razao_social, u.nome AS usuario,
              count(*) FILTER (WHERE i.status = 'enviado')::int AS enviados,
              count(*) FILTER (WHERE i.status = 'erro')::int AS com_erro,
              count(*) FILTER (WHERE n.status = 'autorizada')::int AS autorizadas,
              count(*) FILTER (WHERE n.status IN ('rejeitada','erro'))::int AS rejeitadas,
              count(*) FILTER (WHERE n.status = 'processando')::int AS processando
         FROM lotes l
         JOIN empresas e ON e.id = l.empresa_id
         LEFT JOIN usuarios u ON u.id = l.usuario_id
         LEFT JOIN lote_itens i ON i.lote_id = l.id
         LEFT JOIN notas n ON n.id = i.nota_id
        WHERE $1::int[] IS NULL OR l.empresa_id = ANY($1::int[])
        GROUP BY l.id, e.cnpj, e.razao_social, u.nome
        ORDER BY l.id DESC LIMIT 50`, [ids]);
    res.json(r.rows);
  } catch (e) { next(e); }
});

/* Detalha um lote, linha a linha. */
router.get('/:id', async (req, res, next) => {
  try {
    const l = await db.query(
      `SELECT l.*, e.cnpj, e.razao_social FROM lotes l
        JOIN empresas e ON e.id = l.empresa_id WHERE l.id = $1`, [req.params.id]);
    if (!l.rows.length || !empresaVisivel(req, l.rows[0].empresa_id)) {
      return res.status(404).json({ erro: 'Lote não encontrado' });
    }
    const itens = await db.query(
      `SELECT i.linha, i.status, i.erro, i.dados,
              n.id AS nota_id, n.numero, n.serie, n.status AS status_nota,
              n.chave_acesso, n.ultimo_erro
         FROM lote_itens i LEFT JOIN notas n ON n.id = i.nota_id
        WHERE i.lote_id = $1 ORDER BY i.linha`, [req.params.id]);
    res.json({ lote: l.rows[0], itens: itens.rows });
  } catch (e) { next(e); }
});

module.exports = router;
