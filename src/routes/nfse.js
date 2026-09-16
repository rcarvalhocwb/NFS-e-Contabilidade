const express = require('express');
const db = require('../db');
const { emitir, consultar, consultarEventos, cancelar } = require('../services/emissaoService');
const { criarZip } = require('../util/zip');
const { notaNoEscopo, filtroSqlEmpresas, empresaVisivel } = require('../middleware/escopo');
const auditoria = require('../services/auditoria');
const { validarDocumento, limparDocumento } = require('../util/documento');
const { gerarDanfse } = require('../nfse/danfse');
const { extrairValores, baseCalculo, valorIss } = require('../nfse/extrairValores');
const { gerarCsv } = require('../util/csv');

const router = express.Router();

/* Uma nota cancelada continua existindo e continua sendo consultada — o PDF
   precisa dizer isso na cara, senão circula como se ainda valesse. */
const MARCA = { cancelada: 'CANCELADA', substituida: 'SUBSTITUÍDA' };
const SITUACAO = { autorizada: 'Autorizada', cancelada: 'Cancelada',
                   substituida: 'Substituída' };
function marcaDe(status) {
  return { marcaDagua: MARCA[status] || null, situacao: SITUACAO[status] || null };
}

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
      [limparDocumento(b.cnpjEmpresa)]);
    if (!emp.rows.length || !empresaVisivel(req, emp.rows[0].id)) {
      return res.status(404).json({ erro: 'Empresa não encontrada' });
    }

    const resultado = await emitir(b.cnpjEmpresa, b, {
      // Quem emitiu: fica registrado só quando foi uma pessoa. Emissão por
      // integração responde pelo token da empresa, não por um usuário.
      usuarioId: req.auth.tipo === 'usuario' ? req.auth.usuarioId : null,
      /* A pessoa viu a nota parecida e disse que é outra mesmo. Só ela pode
         dizer isso — o sistema não tem como saber se dois serviços iguais no
         mesmo dia para o mesmo cliente são um engano ou a rotina da casa. */
      confirmaDuplicata: b.confirmaDuplicata === true
    });
    // 200 quando a referência já existia (nada foi criado agora);
    // 202 quando a nota entrou na fila e será transmitida pelo worker.
    res.status(resultado.idempotente ? 200 : 202).json(resultado);
  } catch (e) {
    /* Possível duplicata não é erro de servidor: é uma pergunta.
       Devolve O QUE FOI ACHADO, para a tela poder mostrar a nota anterior em
       vez de dizer "409" e deixar a pessoa adivinhando. */
    if (e.codigo === 'possivel_duplicata') {
      return res.status(409).json({
        erro: e.message, codigo: e.codigo, semelhante: e.semelhante,
        comoSeguir: 'Reenvie com "confirmaDuplicata": true se for outra nota mesmo.'
      });
    }
    next(e);
  }
});

/* Listar notas locais (filtros: cnpjEmpresa, status, limite) */
router.get('/', async (req, res, next) => {
  try {
    const params = [];
    let where = '1=1';
    if (req.query.cnpjEmpresa) {
      params.push(limparDocumento(req.query.cnpjEmpresa));
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
      params.push(limparDocumento(req.query.cnpjEmpresa));
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

/* Exportar os DANFSe em .zip, com os mesmos filtros da listagem.
   Quem fecha o mês precisa dos PDFs para arquivar e para mandar ao cliente —
   baixar um a um é o que a tela evitava até aqui. */
router.get('/export-pdf', async (req, res, next) => {
  try {
    const params = [];
    let where = 'n.nfse_xml IS NOT NULL';
    if (req.query.cnpjEmpresa) {
      params.push(limparDocumento(req.query.cnpjEmpresa));
      where += ` AND e.cnpj = $${params.length}`;
    }
    if (req.query.status) { params.push(req.query.status); where += ` AND n.status = $${params.length}`; }
    if (req.query.ambiente) { params.push(req.query.ambiente); where += ` AND n.ambiente = $${params.length}`; }
    if (req.query.inicio) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(req.query.inicio)) {
        return res.status(400).json({ erro: 'inicio deve ser AAAA-MM-DD' });
      }
      params.push(req.query.inicio); where += ` AND n.criado_em >= $${params.length}::date`;
    }
    if (req.query.fim) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(req.query.fim)) {
        return res.status(400).json({ erro: 'fim deve ser AAAA-MM-DD' });
      }
      params.push(req.query.fim);
      where += ` AND n.criado_em < ($${params.length}::date + interval '1 day')`;
    }
    const escopo = filtroSqlEmpresas(req, 'n.empresa_id', params.length);
    where += escopo.sql;
    params.push(...escopo.params);

    // Gerar PDF é caro: cada um é um documento montado na hora. O teto evita
    // que um filtro largo demais segure o processo por minutos.
    params.push(Math.min(parseInt(req.query.limite || '200', 10), 500));

    const r = await db.query(
      `SELECT n.id, n.chave_acesso, n.numero, n.serie, n.nfse_xml
       FROM notas n JOIN empresas e ON e.id = n.empresa_id
       WHERE ${where} ORDER BY n.numero LIMIT $${params.length}`, params);

    if (!r.rows.length) {
      return res.status(404).json({ erro: 'Nenhuma nota autorizada para os filtros informados' });
    }

    const arquivos = [];
    for (const linha of r.rows) {
      try {
        arquivos.push({
          nome: `NFSe-${linha.serie}-${String(linha.numero).padStart(6, '0')}-` +
                `${linha.chave_acesso || linha.id}.pdf`,
          conteudo: await gerarDanfse(linha.nfse_xml, marcaDe(linha.status))
        });
      } catch (e) {
        // Uma nota com XML estranho não pode impedir o resto do lote
        console.error(`[danfse] falhou na nota ${linha.id}:`, e.message);
      }
    }
    if (!arquivos.length) {
      return res.status(500).json({ erro: 'Não consegui gerar nenhum PDF' });
    }

    const nomeZip = `danfse-${new Date().toISOString().slice(0, 10)}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${nomeZip}"`);
    res.setHeader('X-Total-Pdfs', String(arquivos.length));
    res.send(criarZip(arquivos));
  } catch (e) { next(e); }
});

/* Detalhar nota local (inclui XMLs) */

/* Pacote do período: tudo de um cliente num arquivo só.
 *
 * Fechar o mês de um cliente exigia três downloads separados — XMLs das NFS-e,
 * XMLs das DPS, PDFs — e depois juntar tudo à mão. Quem atende trinta clientes
 * faz isso trinta vezes.
 *
 * O pacote traz, organizado em pastas:
 *   xml/      as NFS-e autorizadas
 *   dps/      as DPS enviadas (o que foi declarado, incluindo rejeitadas)
 *   pdf/      os DANFSe
 *   notas.csv resumo para conferência e importação
 *   LEIA-ME.txt  o que tem dentro e de que período
 *
 * O CSV vai em ponto e vírgula com BOM: é o que o Excel em português abre com
 * as colunas separadas, sem passar pelo assistente de importação.
 */
router.get('/pacote', async (req, res, next) => {
  try {
    const cnpj = req.query.cnpjEmpresa;
    if (!cnpj) return res.status(400).json({ erro: 'Informe a empresa (cnpjEmpresa).' });
    if (!req.query.inicio || !req.query.fim) {
      return res.status(400).json({ erro: 'Informe o período: inicio e fim (AAAA-MM-DD).' });
    }
    for (const campo of ['inicio', 'fim']) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(req.query[campo])) {
        return res.status(400).json({ erro: campo + ' deve ser AAAA-MM-DD' });
      }
    }

    const emp = await db.query(
      'SELECT id, cnpj, razao_social FROM empresas WHERE cnpj = $1',
      [limparDocumento(cnpj)]);
    if (!emp.rows.length || !empresaVisivel(req, emp.rows[0].id)) {
      return res.status(404).json({ erro: 'Empresa não encontrada' });
    }
    const empresa = emp.rows[0];

    const comPdf = req.query.pdf !== '0';
    const params = [empresa.id, req.query.inicio, req.query.fim];
    if (req.query.ambiente) params.push(req.query.ambiente);

    const r = await db.query(
      `SELECT n.id, n.chave_acesso, n.id_dps, n.serie, n.numero, n.status, n.ambiente,
              n.referencia, n.criado_em, n.nfse_xml, n.dps_xml
         FROM notas n
        WHERE n.empresa_id = $1
          AND n.criado_em >= $2::date
          AND n.criado_em < ($3::date + interval '1 day')
          ${req.query.ambiente ? 'AND n.ambiente = $4' : ''}
        ORDER BY n.numero, n.id
        LIMIT 2000`, params);

    if (!r.rows.length) {
      return res.status(404).json({
        erro: 'Nenhuma nota de ' + empresa.razao_social + ' entre ' +
              req.query.inicio + ' e ' + req.query.fim + '.'
      });
    }

    const arquivos = [];
    const linhas = [];
    let autorizadas = 0;

    for (const n of r.rows) {
      const nome = (n.chave_acesso || n.id_dps || String(n.id));
      if (n.nfse_xml) arquivos.push({ nome: `xml/nfse-${nome}.xml`, conteudo: n.nfse_xml });
      if (n.dps_xml)  arquivos.push({ nome: `dps/dps-${nome}.xml`,  conteudo: n.dps_xml });

      /* O resumo sai da NFS-e quando ela existe; da DPS quando não. Assim a
         linha de uma nota rejeitada mostra o que se tentou declarar, em vez de
         uma linha vazia que não ajuda a entender o que aconteceu. */
      let valores = {};
      try { valores = extrairValores(n.nfse_xml || n.dps_xml) || {}; } catch (_) { /* resumo não bloqueia */ }

      if (n.nfse_xml) {
        autorizadas++;
        if (comPdf && arquivos.filter(a => a.nome.startsWith('pdf/')).length < 500) {
          try {
            arquivos.push({ nome: `pdf/DANFSe-${nome}.pdf`,
                            conteudo: await gerarDanfse(n.nfse_xml, marcaDe(n.status)) });
          } catch (e) {
            // Um XML que não vira PDF não pode derrubar o pacote inteiro
            console.warn('[pacote] DANFSe da nota', n.id, 'falhou:', e.message);
          }
        }
      }

      linhas.push({
        serie: n.serie, numero: n.numero, situacao: n.status,
        emissao: n.criado_em ? new Date(n.criado_em).toLocaleDateString('pt-BR') : '',
        tomador: valores.tomador || '', documento: valores.docTomador || '',
        descricao: valores.descricao || '',
        valor_servico: valores.valorServico ?? '',
        base: valores.valorServico != null ? baseCalculo(valores) : '',
        aliquota: valores.aliquota ?? '',
        iss: valorIss(valores) ?? '',
        iss_retido: valores.issRetido ? 'sim' : 'nao',
        ambiente: n.ambiente, referencia: n.referencia || '',
        chave_acesso: n.chave_acesso || ''
      });
    }

    const COLUNAS = [
      { campo: 'serie', titulo: 'Serie' }, { campo: 'numero', titulo: 'Numero' },
      { campo: 'emissao', titulo: 'Emissao' }, { campo: 'situacao', titulo: 'Situacao' },
      { campo: 'tomador', titulo: 'Tomador' }, { campo: 'documento', titulo: 'CNPJ/CPF' },
      { campo: 'descricao', titulo: 'Servico' },
      { campo: 'valor_servico', titulo: 'Valor do servico' },
      { campo: 'base', titulo: 'Base de calculo' },
      { campo: 'aliquota', titulo: 'Aliquota' }, { campo: 'iss', titulo: 'ISS' },
      { campo: 'iss_retido', titulo: 'ISS retido' },
      { campo: 'ambiente', titulo: 'Ambiente' },
      { campo: 'referencia', titulo: 'Referencia' },
      { campo: 'chave_acesso', titulo: 'Chave de acesso' }
    ];
    arquivos.push({ nome: 'notas.csv', conteudo: gerarCsv(COLUNAS, linhas) });
    arquivos.push({ nome: 'LEIA-ME.txt', conteudo:
      `Pacote de notas fiscais de serviço\r\n` +
      `${'='.repeat(42)}\r\n\r\n` +
      `Empresa   : ${empresa.razao_social}\r\n` +
      `CNPJ      : ${empresa.cnpj}\r\n` +
      `Período   : ${req.query.inicio.split('-').reverse().join('/')} a ` +
      `${req.query.fim.split('-').reverse().join('/')}\r\n` +
      `Notas     : ${r.rows.length} (${autorizadas} autorizada(s))\r\n` +
      `Gerado em : ${new Date().toLocaleString('pt-BR')}\r\n\r\n` +
      `Pastas\r\n` +
      `  xml/   NFS-e autorizadas, como a Sefin devolveu\r\n` +
      `  dps/   declarações enviadas, inclusive as rejeitadas\r\n` +
      `  pdf/   DANFSe para arquivo e envio ao cliente\r\n` +
      `  notas.csv  resumo do período, separado por ponto e vírgula\r\n\r\n` +
      `Os XMLs são o documento fiscal; o PDF é a representação impressa.\r\n` +
      `Guarde os XMLs pelo prazo exigido pela legislação.\r\n`
    });

    const zip = criarZip(arquivos);
    const nomeArquivo = `notas-${empresa.cnpj}-${req.query.inicio}-a-${req.query.fim}.zip`;

    await auditoria.registrar(req, empresa.id, 'nota.pacote',
      'Baixou o pacote de ' + r.rows.length + ' nota(s) de ' +
      req.query.inicio.split('-').reverse().join('/') + ' a ' +
      req.query.fim.split('-').reverse().join('/'),
      { detalhe: { notas: r.rows.length, autorizadas, comPdf } });

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${nomeArquivo}"`);
    res.setHeader('X-Total-Notas', String(r.rows.length));
    res.send(zip);
  } catch (e) { next(e); }
});

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
    const pdf = await gerarDanfse(nota.nfse_xml, marcaDe(nota.status));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition',
      `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="DANFSe-${nota.chave_acesso}.pdf"`);
    res.send(pdf);
  } catch (e) { next(e); }
});

/* Quem chamou pode agir em nome desta empresa?
 *
 * As rotas que recebem o CNPJ no corpo/query falam com a Sefin usando o
 * certificado A1 daquela empresa. Sem esta conferência, bastava informar o
 * CNPJ de outro cliente do escritório para consultar — ou cancelar — as notas
 * dele: o gateway assinaria o evento com o certificado alheio, que ele guarda.
 *
 * Devolve 404, e não 403: para quem não tem escopo, a empresa não existe.
 * Responder 403 confirmaria que aquele CNPJ é cliente do escritório. */
async function exigirEmpresaNoEscopo(req, res, cnpj) {
  const emp = await db.query('SELECT id FROM empresas WHERE cnpj = $1',
    [limparDocumento(cnpj)]);
  if (!emp.rows.length || !empresaVisivel(req, emp.rows[0].id)) {
    res.status(404).json({ erro: 'Empresa não encontrada' });
    return false;
  }
  return true;
}

/* Consultar NFS-e na Sefin Nacional pela chave de acesso */
router.get('/:chaveAcesso', async (req, res, next) => {
  try {
    const cnpjEmpresa = req.query.cnpjEmpresa;
    if (!cnpjEmpresa) return res.status(400).json({ erro: 'Informe ?cnpjEmpresa= (certificado usado na consulta)' });
    if (!await exigirEmpresaNoEscopo(req, res, cnpjEmpresa)) return;
    res.json(await consultar(cnpjEmpresa, req.params.chaveAcesso));
  } catch (e) { next(e); }
});

/* Eventos registrados na Sefin para esta NFS-e: cancelamento, substituição.
   O gateway conhece os eventos que ele mesmo enviou; a Sefin conhece também os
   que vieram por outro caminho.

   ATENÇÃO: o caminho GET /nfse/{chave}/eventos devolve HTTP 405 ("does not
   support http method GET") na produção da Sefin, em 20/08/2026 — testado com
   certificado válido, na mesma base em que a consulta da NFS-e responde 200.
   O endpoint correto ainda não foi confirmado no Manual de Integração. A rota
   fica aqui porque o caminho é a única peça em dúvida, e explica o 405 em vez
   de repassá-lo cru. */
router.get('/:chaveAcesso/eventos', async (req, res, next) => {
  try {
    const cnpjEmpresa = req.query.cnpjEmpresa;
    if (!cnpjEmpresa) return res.status(400).json({ erro: 'Informe ?cnpjEmpresa=' });
    if (!await exigirEmpresaNoEscopo(req, res, cnpjEmpresa)) return;

    const r = await consultarEventos(cnpjEmpresa, req.params.chaveAcesso);
    if (r.httpStatus === 405 || r.httpStatus === 404) {
      return res.status(501).json({
        erro: 'A Sefin não atende este caminho de consulta de eventos (HTTP ' +
              r.httpStatus + '). O endereço precisa ser confirmado no Manual de ' +
              'Integração antes de a consulta funcionar.',
        retornoSefin: r.retornoSefin
      });
    }
    res.json(r);
  } catch (e) { next(e); }
});

/* Cancelar NFS-e.
   Body: { cnpjEmpresa, codigoMotivo (1=erro emissão, 2=serviço não prestado, 9=outros), motivo } */
router.post('/:chaveAcesso/cancelamento', async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.cnpjEmpresa) return res.status(400).json({ erro: 'cnpjEmpresa é obrigatório' });
    // Cancelar é irreversível e assina com o certificado A1 da empresa: o
    // escopo é conferido antes de qualquer outra coisa
    if (!await exigirEmpresaNoEscopo(req, res, b.cnpjEmpresa)) return;
    // A Sefin exige xMotivo em qualquer código; o builder preenche um texto
    // padrão quando não vem informado. Para "Outros" o texto próprio é
    // obrigatório — o padrão genérico não descreve nada.
    if (Number(b.codigoMotivo) === 9 && !b.motivo) {
      return res.status(400).json({ erro: 'motivo é obrigatório quando codigoMotivo = 9 (Outros)' });
    }
    const resultado = await cancelar(b.cnpjEmpresa, req.params.chaveAcesso, b);

    if (resultado.cancelada) {
      const emp = await db.query('SELECT id FROM empresas WHERE cnpj = $1',
        [limparDocumento(b.cnpjEmpresa)]);
      await auditoria.registrar(req, emp.rows[0] && emp.rows[0].id, 'nota.cancelada',
        'Cancelou a NFS-e ' + req.params.chaveAcesso.slice(-8) +
        (b.motivo ? ' — ' + b.motivo : ''),
        { referencia: req.params.chaveAcesso,
          detalhe: { codigoMotivo: b.codigoMotivo || 1, motivo: b.motivo || null } });
    }
    res.status(resultado.cancelada ? 200 : 422).json(resultado);
  } catch (e) { next(e); }
});

module.exports = router;
