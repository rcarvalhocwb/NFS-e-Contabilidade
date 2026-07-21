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
                             op_simp_nac, reg_esp_trib, serie_dps, ambiente)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [
        cnpj, b.razaoSocial, b.inscricaoMunicipal || null, String(b.codigoMunicipio),
        b.opSimpNac ?? 1, b.regEspTrib ?? 0, b.serieDps || '1',
        b.ambiente === 'producao' ? 'producao' : 'homologacao'
      ]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ erro: 'Empresa já cadastrada' });
    next(e);
  }
});

/* Listar empresas */
router.get('/', async (_req, res, next) => {
  try {
    const r = await db.query(
      `SELECT e.id, e.cnpj, e.razao_social, e.inscricao_municipal, e.codigo_municipio,
              e.op_simp_nac, e.reg_esp_trib, e.serie_dps, e.prox_num_dps, e.ambiente, e.ativo,
              c.valido_ate AS certificado_valido_ate, c.subject AS certificado_subject
       FROM empresas e
       LEFT JOIN LATERAL (
         SELECT valido_ate, subject FROM certificados
         WHERE empresa_id = e.id AND ativo ORDER BY criado_em DESC LIMIT 1
       ) c ON TRUE
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
         serie_dps           = COALESCE($7, serie_dps),
         ambiente            = COALESCE($8, ambiente),
         ativo               = COALESCE($9, ativo),
         atualizado_em       = now()
       WHERE cnpj = $1 RETURNING *`,
      [
        limparCnpj(req.params.cnpj),
        b.razaoSocial ?? null, b.inscricaoMunicipal ?? null,
        b.codigoMunicipio ? String(b.codigoMunicipio) : null,
        b.opSimpNac ?? null, b.regEspTrib ?? null, b.serieDps ?? null,
        b.ambiente ?? null, typeof b.ativo === 'boolean' ? b.ativo : null
      ]
    );
    if (!r.rows.length) return res.status(404).json({ erro: 'Empresa não encontrada' });
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
