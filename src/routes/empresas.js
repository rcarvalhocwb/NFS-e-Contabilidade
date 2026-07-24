const express = require('express');
const multer = require('multer');
const db = require('../db');
const { salvarCertificado } = require('../services/certificadoService');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 } });

function limparCnpj(v) { return String(v || '').replace(/\D/g, ''); }

/* Cadastrar empresa */
router.post('/', async (req, res, next) => {
  try {
    const b = req.body || {};
    const cnpj = limparCnpj(b.cnpj);
    if (cnpj.length !== 14) return res.status(400).json({ erro: 'cnpj inválido' });
    if (!b.razaoSocial) return res.status(400).json({ erro: 'razaoSocial é obrigatória' });
    if (!/^\d{7}$/.test(String(b.codigoMunicipio || ''))) {
      return res.status(400).json({ erro: 'codigoMunicipio deve ser o código IBGE de 7 dígitos' });
    }
    const r = await db.query(
      `INSERT INTO empresas (cnpj, razao_social, inscricao_municipal, codigo_municipio,
                             op_simp_nac, reg_esp_trib, ambiente,
                             nome_fantasia, inscricao_estadual, cep, logradouro, numero,
                             complemento, bairro, uf, email, telefone,
                             responsavel_nome, responsavel_cpf, contador_doc)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
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
        (b.contadorDoc || '').replace(/\D/g, '') || null
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
    res.status(201).json(empresa);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ erro: 'Empresa já cadastrada' });
    next(e);
  }
});

/* Listar empresas */
router.get('/', async (_req, res, next) => {
  try {
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
       ORDER BY e.razao_social`
    );
    res.json(r.rows);
  } catch (e) { next(e); }
});

/* Detalhar empresa */
router.get('/:cnpj', async (req, res, next) => {
  try {
    const r = await db.query('SELECT * FROM empresas WHERE cnpj = $1', [limparCnpj(req.params.cnpj)]);
    if (!r.rows.length) return res.status(404).json({ erro: 'Empresa não encontrada' });
    res.json(r.rows[0]);
  } catch (e) { next(e); }
});

/* Atualizar empresa */
router.put('/:cnpj', async (req, res, next) => {
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
        b.contadorDoc ? b.contadorDoc.replace(/\D/g, '') : null
      ]
    );
    if (!r.rows.length) return res.status(404).json({ erro: 'Empresa não encontrada' });
    res.json(r.rows[0]);
  } catch (e) { next(e); }
});

/* Numeração da DPS por ambiente (homologação e produção são independentes) */
router.get('/:cnpj/numeracao', async (req, res, next) => {
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
router.put('/:cnpj/numeracao', async (req, res, next) => {
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
router.post('/:cnpj/certificado', upload.single('certificado'), async (req, res, next) => {
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
