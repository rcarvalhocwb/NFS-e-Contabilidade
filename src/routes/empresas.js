const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const db = require('../db');
const { salvarCertificado } = require('../services/certificadoService');
const { validarCnpj, limparDocumento } = require('../util/documento');
const { somenteAdmin, empresasVisiveis, empresaVisivel } = require('../middleware/escopo');
const { extrairValores } = require('../nfse/extrairValores');

const auditoria = require('../services/auditoria');

const router = express.Router();

const NOME_AMBIENTE = { producao: 'produção', homologacao: 'homologação' };
function nomeAmbiente(a) { return NOME_AMBIENTE[a] || a; }
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 } });

// CNPJ alfanumérico (julho/2026): letras nas 12 primeiras posições.
const limparCnpj = limparDocumento;

/* Barra o acesso a uma empresa fora do escopo de quem pediu. 404, e não 403:
   para o operador, uma empresa que não é dele simplesmente não existe. */
async function exigirEmpresaVisivel(req, res, next) {
  try {
    const r = await db.query('SELECT id FROM empresas WHERE cnpj = $1',
      [limparCnpj(req.params.cnpj)]);
    if (!r.rows.length || !empresaVisivel(req, r.rows[0].id)) {
      return res.status(404).json({ erro: 'Empresa não encontrada' });
    }
    next();
  } catch (e) { next(e); }
}

/* Cadastrar empresa */
router.post('/', somenteAdmin, async (req, res, next) => {
  try {
    const b = req.body || {};
    const cnpj = limparCnpj(b.cnpj);
    if (!validarCnpj(cnpj)) {
      return res.status(400).json({ erro: 'CNPJ inválido (verifique os dígitos)' });
    }
    if (!b.razaoSocial) return res.status(400).json({ erro: 'razaoSocial é obrigatória' });
    if (!/^\d{7}$/.test(String(b.codigoMunicipio || ''))) {
      return res.status(400).json({ erro: 'codigoMunicipio deve ser o código IBGE de 7 dígitos' });
    }
    const r = await db.query(
      `INSERT INTO empresas (cnpj, razao_social, inscricao_municipal, codigo_municipio,
                             op_simp_nac, reg_esp_trib, ambiente,
                             nome_fantasia, inscricao_estadual, cep, logradouro, numero,
                             complemento, bairro, uf, email, telefone,
                             responsavel_nome, responsavel_cpf, contador_doc, email_tomador_ativo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       RETURNING *`,
      [
        cnpj, b.razaoSocial, b.inscricaoMunicipal || null, String(b.codigoMunicipio),
        b.opSimpNac ?? 1, b.regEspTrib ?? 0,
        b.ambiente === 'producao' ? 'producao' : 'homologacao',
        b.nomeFantasia || null, b.inscricaoEstadual || null,
        (b.cep || '').replace(/\D/g, '') || null, b.logradouro || null, b.numero || null,
        b.complemento || null, b.bairro || null, (b.uf || '').toUpperCase() || null,
        b.email || null, b.telefone || null,
        b.responsavelNome || null, (b.responsavelCpf || '').replace(/\D/g, '') || null,
        limparDocumento(b.contadorDoc) || null,
        b.emailTomadorAtivo === true
      ]
    );
    const empresa = r.rows[0];

    // Cria a numeração dos dois ambientes já no cadastro, para que a série
    // possa ser definida antes da primeira emissão.
    await db.query(
      `INSERT INTO numeracao_dps (empresa_id, ambiente, serie, prox_numero)
       VALUES ($1,'homologacao',$2,1), ($1,'producao',$2,1)
       ON CONFLICT (empresa_id, ambiente) DO NOTHING`,
      [empresa.id, b.serieDps || '1']
    );

    // Gera os tokens de API já no cadastro: a empresa nasce pronta para
    // integrar, sem passo manual de "criar credencial" depois.
    // Os tokens nascem aqui e são devolvidos UMA vez: o banco guarda só o
    // hash, então não há como reexibi-los depois. Quem perder, gera outro.
    const tokens = ['homologacao', 'producao'].map(ambiente => ({
      ambiente, token: crypto.randomBytes(24).toString('hex')
    }));
    for (const t of tokens) {
      await db.query(
        `INSERT INTO empresa_tokens (empresa_id, ambiente, token_hash, descricao)
         VALUES ($1,$2,$3,'Gerado no cadastro')
         ON CONFLICT (empresa_id, ambiente) DO NOTHING`,
        [empresa.id, t.ambiente,
         crypto.createHash('sha256').update(t.token).digest('hex')]);
    }

    // Devolve os tokens no cadastro — é o único momento em que aparecem sem
    // consulta extra, e é o que a contabilidade entrega ao sistema cliente.
    res.status(201).json({
      ...empresa,
      tokens,
      integracao: `/integracao/${empresa.cnpj}`
    });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ erro: 'Empresa já cadastrada' });
    next(e);
  }
});

/* Listar empresas — só as visíveis a quem pediu. O operador precisa da lista
   para escolher a empresa na emissão, mas não das que não estão no seu escopo. */
router.get('/', async (req, res, next) => {
  try {
    const ids = empresasVisiveis(req);
    const r = await db.query(
      `SELECT e.id, e.cnpj, e.razao_social, e.nome_fantasia, e.inscricao_municipal,
              e.codigo_municipio, e.op_simp_nac, e.reg_esp_trib, e.ambiente, e.ativo,
              e.uf, e.email,
              c.valido_ate AS certificado_valido_ate, c.subject AS certificado_subject,
              n.serie AS serie_dps, n.prox_numero AS prox_num_dps
       FROM empresas e
       LEFT JOIN LATERAL (
         SELECT valido_ate, subject FROM certificados
         WHERE empresa_id = e.id AND ativo ORDER BY criado_em DESC LIMIT 1
       ) c ON TRUE
       -- numeração do ambiente em que a empresa está operando
       LEFT JOIN numeracao_dps n ON n.empresa_id = e.id AND n.ambiente = e.ambiente
       WHERE $1::int[] IS NULL OR e.id = ANY($1::int[])
       ORDER BY e.razao_social`,
      [ids]
    );
    res.json(r.rows);
  } catch (e) { next(e); }
});

/* Detalhar empresa */
router.get('/:cnpj', exigirEmpresaVisivel, async (req, res, next) => {
  try {
    const r = await db.query('SELECT * FROM empresas WHERE cnpj = $1', [limparCnpj(req.params.cnpj)]);
    if (!r.rows.length) return res.status(404).json({ erro: 'Empresa não encontrada' });
    res.json(r.rows[0]);
  } catch (e) { next(e); }
});

/* Atualizar empresa */
router.put('/:cnpj', somenteAdmin, exigirEmpresaVisivel, async (req, res, next) => {
  try {
    const b = req.body || {};
    const r = await db.query(
      `UPDATE empresas SET
         razao_social        = COALESCE($2, razao_social),
         inscricao_municipal = COALESCE($3, inscricao_municipal),
         codigo_municipio    = COALESCE($4, codigo_municipio),
         op_simp_nac         = COALESCE($5, op_simp_nac),
         reg_esp_trib        = COALESCE($6, reg_esp_trib),
         ambiente            = COALESCE($7, ambiente),
         ativo               = COALESCE($8, ativo),
         nome_fantasia       = COALESCE($9, nome_fantasia),
         inscricao_estadual  = COALESCE($10, inscricao_estadual),
         cep                 = COALESCE($11, cep),
         logradouro          = COALESCE($12, logradouro),
         numero              = COALESCE($13, numero),
         complemento         = COALESCE($14, complemento),
         bairro              = COALESCE($15, bairro),
         uf                  = COALESCE($16, uf),
         email               = COALESCE($17, email),
         telefone            = COALESCE($18, telefone),
         responsavel_nome    = COALESCE($19, responsavel_nome),
         responsavel_cpf     = COALESCE($20, responsavel_cpf),
         contador_doc        = COALESCE($21, contador_doc),
         email_tomador_ativo = COALESCE($22, email_tomador_ativo),
         atualizado_em       = now()
       WHERE cnpj = $1 RETURNING *`,
      [
        limparCnpj(req.params.cnpj),
        b.razaoSocial ?? null, b.inscricaoMunicipal ?? null,
        b.codigoMunicipio ? String(b.codigoMunicipio) : null,
        b.opSimpNac ?? null, b.regEspTrib ?? null,
        b.ambiente ?? null, typeof b.ativo === 'boolean' ? b.ativo : null,
        b.nomeFantasia ?? null, b.inscricaoEstadual ?? null,
        b.cep ? b.cep.replace(/\D/g, '') : null,
        b.logradouro ?? null, b.numero ?? null, b.complemento ?? null,
        b.bairro ?? null, b.uf ? b.uf.toUpperCase() : null,
        b.email ?? null, b.telefone ?? null,
        b.responsavelNome ?? null,
        b.responsavelCpf ? b.responsavelCpf.replace(/\D/g, '') : null,
        b.contadorDoc ? limparDocumento(b.contadorDoc) : null,
        typeof b.emailTomadorAtivo === 'boolean' ? b.emailTomadorAtivo : null
      ]
    );
    if (!r.rows.length) return res.status(404).json({ erro: 'Empresa não encontrada' });
    res.json(r.rows[0]);
  } catch (e) { next(e); }
});

/* Painel da empresa: tudo que o contador precisa saber sobre um cliente numa
   tela só. Antes disso, responder "como está a empresa X" exigia passar por
   Notas, Relatórios e Lotes, filtrando cada um. */
router.get('/:cnpj/resumo', exigirEmpresaVisivel, async (req, res, next) => {
  try {
    const cnpj = limparCnpj(req.params.cnpj);
    const emp = await db.query('SELECT * FROM empresas WHERE cnpj = $1', [cnpj]);
    if (!emp.rows.length) return res.status(404).json({ erro: 'Empresa não encontrada' });
    const id = emp.rows[0].id;

    const [cert, numeracao, mes, ano, ultimas, lotes, clientes, servicos, pendencias] =
      await Promise.all([
        db.query(`SELECT subject, valido_ate, criado_em,
                         EXTRACT(DAY FROM (valido_ate - now()))::int AS dias
                    FROM certificados WHERE empresa_id = $1 AND ativo
                   ORDER BY criado_em DESC LIMIT 1`, [id]),

        db.query(`SELECT ambiente, serie, prox_numero, atualizado_em
                    FROM numeracao_dps WHERE empresa_id = $1 ORDER BY ambiente`, [id]),

        // Mês corrente, por status: é o número que o contador olha primeiro
        db.query(`SELECT status, count(*)::int AS total
                    FROM notas WHERE empresa_id = $1
                     AND criado_em >= date_trunc('month', now())
                   GROUP BY status`, [id]),

        // Doze meses, para ver sazonalidade e comparar com o mês anterior
        db.query(`SELECT to_char(date_trunc('month', criado_em), 'YYYY-MM') AS mes,
                         count(*)::int AS total,
                         count(*) FILTER (WHERE status = 'autorizada')::int AS autorizadas
                    FROM notas WHERE empresa_id = $1
                     AND criado_em >= date_trunc('month', now()) - interval '11 months'
                   GROUP BY 1 ORDER BY 1`, [id]),

        db.query(`SELECT n.id, n.serie, n.numero, n.status, n.ambiente, n.referencia,
                         n.chave_acesso, n.criado_em, n.ultimo_erro, n.dps_xml,
                         u.nome AS emitida_por
                    FROM notas n LEFT JOIN usuarios u ON u.id = n.usuario_id
                   WHERE n.empresa_id = $1 ORDER BY n.id DESC LIMIT 10`, [id]),

        db.query(`SELECT l.id, l.descricao, l.total, l.ambiente, l.criado_em,
                         count(*) FILTER (WHERE i.status = 'erro')::int AS com_erro
                    FROM lotes l LEFT JOIN lote_itens i ON i.lote_id = l.id
                   WHERE l.empresa_id = $1
                   GROUP BY l.id ORDER BY l.id DESC LIMIT 5`, [id]),

        db.query('SELECT count(*)::int AS total FROM tomadores WHERE empresa_id = $1', [id]),
        db.query('SELECT count(*)::int AS total FROM servicos WHERE empresa_id = $1 AND ativo', [id]),

        // O que trava a operação, para aparecer antes dos números
        db.query(`SELECT count(*)::int AS na_fila
                    FROM notas WHERE empresa_id = $1 AND status = 'processando'`, [id])
      ]);

    const porStatus = {};
    mes.rows.forEach(r => { porStatus[r.status] = r.total; });

    res.json({
      empresa: emp.rows[0],
      certificado: cert.rows[0] || null,
      numeracao: numeracao.rows,
      mes: {
        porStatus,
        total: Object.values(porStatus).reduce((a, b) => a + b, 0),
        autorizadas: porStatus.autorizada || 0
      },
      historico: ano.rows,
      ultimasNotas: ultimas.rows.map(n => {
        const { dps_xml, ...resto } = n;
        return Object.assign(resto, { valores: extrairValores(dps_xml) });
      }),
      lotes: lotes.rows,
      cadastros: { clientes: clientes.rows[0].total, servicos: servicos.rows[0].total },
      naFila: pendencias.rows[0].na_fila
    });
  } catch (e) { next(e); }
});

/* Troca o ambiente de operação da empresa.
   Rota própria, e não um campo no meio do cadastro: passar para produção muda
   o que a próxima nota significa — vira documento fiscal e gera imposto. Ter
   endereço próprio deixa a ação explícita e permite exigir a confirmação. */
router.put('/:cnpj/ambiente', somenteAdmin, exigirEmpresaVisivel, async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!['homologacao', 'producao'].includes(b.ambiente)) {
      return res.status(400).json({ erro: "ambiente deve ser 'homologacao' ou 'producao'" });
    }
    if (b.ambiente === 'producao' && b.confirmo !== true) {
      return res.status(400).json({
        erro: 'Para passar à produção, confirme: as notas emitidas passam a ter ' +
              'valor fiscal e a gerar imposto.'
      });
    }

    const cnpj = limparCnpj(req.params.cnpj);
    const emp = await db.query('SELECT id, ambiente FROM empresas WHERE cnpj = $1', [cnpj]);
    if (!emp.rows.length) return res.status(404).json({ erro: 'Empresa não encontrada' });

    // Sem certificado não adianta trocar: a emissão falharia no primeiro envio
    if (b.ambiente === 'producao') {
      const cert = await db.query(
        'SELECT valido_ate FROM certificados WHERE empresa_id = $1 AND ativo LIMIT 1',
        [emp.rows[0].id]);
      if (!cert.rows.length) {
        return res.status(400).json({
          erro: 'Anexe o certificado digital antes de passar esta empresa para produção.'
        });
      }
      if (new Date(cert.rows[0].valido_ate) < new Date()) {
        return res.status(400).json({
          erro: 'O certificado desta empresa está vencido. Renove antes de emitir em produção.'
        });
      }
    }

    const r = await db.query(
      'UPDATE empresas SET ambiente = $1 WHERE cnpj = $2 RETURNING cnpj, razao_social, ambiente',
      [b.ambiente, cnpj]);

    // A numeração é independente por ambiente; avisar de onde a próxima sai
    const num = await db.query(
      'SELECT serie, prox_numero FROM numeracao_dps WHERE empresa_id = $1 AND ambiente = $2',
      [emp.rows[0].id, b.ambiente]);

    await auditoria.registrar(req, emp.rows[0].id, 'empresa.ambiente',
      'Mudou o ambiente de ' + nomeAmbiente(emp.rows[0].ambiente) +
      ' para ' + nomeAmbiente(b.ambiente),
      { detalhe: { de: emp.rows[0].ambiente, para: b.ambiente } });

    console.log(`[empresa] ${cnpj}: ambiente ${emp.rows[0].ambiente} -> ${b.ambiente}` +
                (req.auth.tipo === 'usuario' ? ` (por ${req.auth.email})` : ''));

    res.json(Object.assign(r.rows[0], {
      anterior: emp.rows[0].ambiente,
      numeracao: num.rows[0] || null
    }));
  } catch (e) { next(e); }
});

/* Padrões fiscais da empresa.
   Rota própria: são os campos que a emissão puxa sozinha, e misturá-los no
   cadastro geral tornaria ainda maior um UPDATE que já tem vinte colunas. */
router.get('/:cnpj/padroes-fiscais', exigirEmpresaVisivel, async (req, res, next) => {
  try {
    const r = await db.query(
      `SELECT cod_tributacao_padrao, cod_tributacao_municipal, cod_nbs_padrao,
              descricao_padrao, aliquota_iss_padrao, iss_retido_padrao,
              perc_total_tributos, tributacao_issqn_padrao, op_simp_nac
         FROM empresas WHERE cnpj = $1`, [limparCnpj(req.params.cnpj)]);
    if (!r.rows.length) return res.status(404).json({ erro: 'Empresa não encontrada' });
    res.json(r.rows[0]);
  } catch (e) { next(e); }
});

router.put('/:cnpj/padroes-fiscais', somenteAdmin, exigirEmpresaVisivel, async (req, res, next) => {
  try {
    const b = req.body || {};

    // Formatos conferidos aqui: gravar um NBS de 7 dígitos como padrão faria
    // toda nota da empresa nascer errada, e a Sefin só reclama depois de
    // reservar número e assinar (E1235).
    const cod = b.codigoTributacao ? String(b.codigoTributacao).replace(/\D/g, '') : null;
    if (cod && cod.length !== 6) {
      return res.status(400).json({ erro: 'O código de tributação tem 6 dígitos (cTribNac).' });
    }
    const nbs = b.codigoNbs ? String(b.codigoNbs).replace(/\D/g, '') : null;
    if (nbs && nbs.length !== 9) {
      return res.status(400).json({ erro: 'O código NBS tem 9 dígitos.' });
    }
    const natureza = b.tributacaoIssqn !== undefined ? Number(b.tributacaoIssqn) : null;
    if (natureza !== null && ![1, 2, 3, 4].includes(natureza)) {
      return res.status(400).json({ erro: 'Natureza da operação deve ser 1, 2, 3 ou 4.' });
    }

    /* Edição parcial: o que o corpo não menciona fica como está. A alternativa
       — sobrescrever tudo — apagou os padrões de uma empresa quando um corpo
       chegou vazio por falta de content-type. O 200 escondeu a perda, e só a
       nota seguinte, nascendo em branco, denunciaria. Campo presente e vazio
       continua limpando: é o operador apagando de propósito. */
    const num = v => (v === undefined || v === '' || v === null ? null : Number(v));
    const colunas = [];
    const valores = [limparCnpj(req.params.cnpj)];
    const põe = (coluna, valor) => {
      valores.push(valor);
      colunas.push(`${coluna} = $${valores.length}`);
    };

    if (b.codigoTributacao !== undefined) põe('cod_tributacao_padrao', cod);
    if (b.codigoTributacaoMunicipal !== undefined) {
      põe('cod_tributacao_municipal', b.codigoTributacaoMunicipal || null);
    }
    if (b.codigoNbs !== undefined) põe('cod_nbs_padrao', nbs);
    if (b.descricao !== undefined) põe('descricao_padrao', b.descricao || null);
    if (b.aliquotaIss !== undefined) põe('aliquota_iss_padrao', num(b.aliquotaIss));
    if (b.issRetido !== undefined) põe('iss_retido_padrao', !!b.issRetido);
    if (b.percentualTotalTributos !== undefined) {
      põe('perc_total_tributos', num(b.percentualTotalTributos));
    }
    if (natureza !== null) põe('tributacao_issqn_padrao', natureza);

    if (!colunas.length) {
      return res.status(400).json({
        erro: 'Nenhum padrão foi informado. Se a intenção era limpar um campo, ' +
              'envie-o vazio; um corpo sem campos não altera nada.'
      });
    }

    const r = await db.query(
      `UPDATE empresas SET ${colunas.join(', ')}, atualizado_em = now()
       WHERE cnpj = $1
       RETURNING cod_tributacao_padrao, cod_tributacao_municipal, cod_nbs_padrao,
                 descricao_padrao, aliquota_iss_padrao, iss_retido_padrao,
                 perc_total_tributos, tributacao_issqn_padrao`, valores);

    if (!r.rows.length) return res.status(404).json({ erro: 'Empresa não encontrada' });
    res.json(r.rows[0]);
  } catch (e) { next(e); }
});

/* Histórico do cliente: tudo que aconteceu nele, do mais recente ao mais
   antigo. É a trilha de auditoria lida do ângulo de quem atende a empresa. */
router.get('/:cnpj/historico', exigirEmpresaVisivel, async (req, res, next) => {
  try {
    const emp = await db.query('SELECT id FROM empresas WHERE cnpj = $1',
      [limparCnpj(req.params.cnpj)]);
    res.json(await auditoria.historico(emp.rows[0].id, {
      limite: req.query.limite, acao: req.query.acao || null
    }));
  } catch (e) { next(e); }
});

/* Numeração da DPS por ambiente (homologação e produção são independentes) */
router.get('/:cnpj/numeracao', exigirEmpresaVisivel, async (req, res, next) => {
  try {
    const r = await db.query(
      `SELECT n.ambiente, n.serie, n.prox_numero, n.atualizado_em
       FROM numeracao_dps n JOIN empresas e ON e.id = n.empresa_id
       WHERE e.cnpj = $1 ORDER BY n.ambiente`,
      [limparCnpj(req.params.cnpj)]
    );
    res.json(r.rows);
  } catch (e) { next(e); }
});

/* Ajusta série/próximo número de UM ambiente.
   Body: { ambiente: 'homologacao'|'producao', serie, proxNumero } */
router.put('/:cnpj/numeracao', somenteAdmin, exigirEmpresaVisivel, async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!['homologacao', 'producao'].includes(b.ambiente)) {
      return res.status(400).json({ erro: "ambiente deve ser 'homologacao' ou 'producao'" });
    }
    if (b.proxNumero !== undefined && (!Number.isInteger(Number(b.proxNumero)) || Number(b.proxNumero) < 1)) {
      return res.status(400).json({ erro: 'proxNumero deve ser inteiro >= 1' });
    }
    const emp = await db.query('SELECT id FROM empresas WHERE cnpj = $1', [limparCnpj(req.params.cnpj)]);
    if (!emp.rows.length) return res.status(404).json({ erro: 'Empresa não encontrada' });

    const r = await db.query(
      `INSERT INTO numeracao_dps (empresa_id, ambiente, serie, prox_numero)
       VALUES ($1,$2,COALESCE($3,'1'),COALESCE($4,1))
       ON CONFLICT (empresa_id, ambiente) DO UPDATE SET
         serie = COALESCE($3, numeracao_dps.serie),
         prox_numero = COALESCE($4, numeracao_dps.prox_numero),
         atualizado_em = now()
       RETURNING ambiente, serie, prox_numero`,
      [emp.rows[0].id, b.ambiente, b.serie ?? null, b.proxNumero ?? null]
    );
    res.json(r.rows[0]);
  } catch (e) { next(e); }
});

/* Upload do certificado A1 (.pfx): multipart/form-data
   campos: certificado (arquivo), senha (texto) */
router.post('/:cnpj/certificado', somenteAdmin, exigirEmpresaVisivel,
  upload.single('certificado'), async (req, res, next) => {
  try {
    const emp = await db.query('SELECT id FROM empresas WHERE cnpj = $1', [limparCnpj(req.params.cnpj)]);
    if (!emp.rows.length) return res.status(404).json({ erro: 'Empresa não encontrada' });
    if (!req.file) return res.status(400).json({ erro: 'Envie o arquivo .pfx no campo "certificado"' });
    if (!req.body.senha) return res.status(400).json({ erro: 'Informe o campo "senha"' });

    const cert = await salvarCertificado(emp.rows[0].id, req.file.buffer, req.body.senha);
    res.status(201).json({
      mensagem: 'Certificado cadastrado',
      subject: cert.subject,
      cnpjCertificado: cert.cnpj_cert,
      validoAte: cert.valido_ate
    });
  } catch (e) {
    if (/senha|password|PKCS|Invalid/i.test(e.message)) {
      return res.status(400).json({ erro: 'Não foi possível ler o PFX. Verifique arquivo e senha.', detalhe: e.message });
    }
    next(e);
  }
});

module.exports = router;
