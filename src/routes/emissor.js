const express = require('express');
const db = require('../db');
const { validarDocumento, soDigitos } = require('../util/documento');
const { consultarCnpj } = require('../services/consultaExterna');
const { empresasVisiveis, empresaVisivel } = require('../middleware/escopo');

const router = express.Router();

/* Dados que a tela de emissão precisa para montar as opções: empresas prontas
   para emitir, tomadores e serviços já usados. Uma chamada só, para a tela
   abrir preenchida em vez de pedir tudo em sequência. */
router.get('/contexto', async (req, res, next) => {
  try {
    const empresas = await db.query(
      `SELECT e.id, e.cnpj, e.razao_social, e.nome_fantasia, e.ambiente, e.op_simp_nac,
              (c.id IS NOT NULL) AS tem_certificado,
              c.valido_ate AS certificado_valido_ate
         FROM empresas e
         LEFT JOIN LATERAL (
           SELECT id, valido_ate FROM certificados
            WHERE empresa_id = e.id AND ativo ORDER BY criado_em DESC LIMIT 1
         ) c ON TRUE
        WHERE e.ativo AND ($1::int[] IS NULL OR e.id = ANY($1::int[]))
        ORDER BY e.razao_social`, [empresasVisiveis(req)]);

    const empresaId = req.query.empresaId ? Number(req.query.empresaId) : null;
    let tomadores = { rows: [] };
    let servicos = { rows: [] };
    // Sem o guard, bastaria trocar o empresaId na URL para ler a carteira de
    // clientes de outra empresa do grupo.
    if (empresaId && empresaVisivel(req, empresaId)) {
      tomadores = await db.query(
        `SELECT * FROM tomadores WHERE empresa_id = $1
          ORDER BY vezes_usado DESC, ultimo_uso DESC NULLS LAST LIMIT 50`, [empresaId]);
      servicos = await db.query(
        `SELECT * FROM servicos WHERE empresa_id = $1 AND ativo
          ORDER BY vezes_usado DESC, ultimo_uso DESC NULLS LAST LIMIT 50`, [empresaId]);
    }

    res.json({ empresas: empresas.rows, tomadores: tomadores.rows, servicos: servicos.rows });
  } catch (e) { next(e); }
});

/* Busca um tomador já cadastrado; se não houver, consulta a base pública pelo
   CNPJ. Assim o operador digita o documento e o resto vem preenchido. */
router.get('/tomador/:documento', async (req, res, next) => {
  try {
    const doc = soDigitos(req.params.documento);
    if (!validarDocumento(doc)) {
      return res.status(400).json({ erro: 'Documento inválido (verifique os dígitos)' });
    }
    const empresaId = Number(req.query.empresaId);
    if (empresaId && empresaVisivel(req, empresaId)) {
      const salvo = await db.query(
        'SELECT * FROM tomadores WHERE empresa_id = $1 AND documento = $2', [empresaId, doc]);
      if (salvo.rows.length) return res.json({ origem: 'cadastro', tomador: salvo.rows[0] });
    }
    // CPF não tem base pública consultável; só CNPJ.
    if (doc.length !== 14) {
      return res.json({ origem: 'novo', tomador: { documento: doc } });
    }
    try {
      const d = await consultarCnpj(doc);
      res.json({
        origem: 'receita',
        tomador: {
          documento: doc, razao_social: d.razaoSocial, email: d.email, telefone: d.telefone,
          codigo_municipio: d.codigoMunicipio, cep: d.cep, logradouro: d.logradouro,
          numero: d.numero, complemento: d.complemento, bairro: d.bairro, uf: d.uf
        }
      });
    } catch (_) {
      // Consulta externa indisponível não impede emitir — só não preenche.
      res.json({ origem: 'novo', tomador: { documento: doc } });
    }
  } catch (e) { next(e); }
});

/* Salva/atualiza o tomador para as próximas emissões. */
router.post('/tomador', async (req, res, next) => {
  try {
    const b = req.body || {};
    const doc = soDigitos(b.documento);
    if (!validarDocumento(doc)) return res.status(400).json({ erro: 'Documento inválido' });
    if (!b.empresaId) return res.status(400).json({ erro: 'empresaId é obrigatório' });
    if (!empresaVisivel(req, b.empresaId)) {
      return res.status(404).json({ erro: 'Empresa não encontrada' });
    }
    if (!b.razaoSocial) return res.status(400).json({ erro: 'razaoSocial é obrigatória' });

    const r = await db.query(
      `INSERT INTO tomadores (empresa_id, documento, razao_social, email, telefone,
                              codigo_municipio, cep, logradouro, numero, complemento, bairro, uf)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (empresa_id, documento) DO UPDATE SET
         razao_social = EXCLUDED.razao_social, email = EXCLUDED.email,
         telefone = EXCLUDED.telefone, codigo_municipio = EXCLUDED.codigo_municipio,
         cep = EXCLUDED.cep, logradouro = EXCLUDED.logradouro, numero = EXCLUDED.numero,
         complemento = EXCLUDED.complemento, bairro = EXCLUDED.bairro, uf = EXCLUDED.uf
       RETURNING *`,
      [b.empresaId, doc, b.razaoSocial, b.email || null, b.telefone || null,
       b.codigoMunicipio || null, soDigitos(b.cep) || null, b.logradouro || null,
       b.numero || null, b.complemento || null, b.bairro || null,
       (b.uf || '').toUpperCase() || null]);
    res.status(201).json(r.rows[0]);
  } catch (e) { next(e); }
});

/* Serviços salvos: o operador escolhe pelo apelido, sem lidar com cTribNac. */
router.post('/servico', async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.empresaId) return res.status(400).json({ erro: 'empresaId é obrigatório' });
    if (!empresaVisivel(req, b.empresaId)) {
      return res.status(404).json({ erro: 'Empresa não encontrada' });
    }
    if (!b.apelido) return res.status(400).json({ erro: 'apelido é obrigatório' });
    if (!/^\d{6}$/.test(String(b.codigoTributacao || ''))) {
      return res.status(400).json({ erro: 'codigoTributacao deve ter 6 dígitos (cTribNac)' });
    }
    if (!b.descricao) return res.status(400).json({ erro: 'descricao é obrigatória' });

    const r = await db.query(
      `INSERT INTO servicos (empresa_id, apelido, codigo_tributacao, descricao,
                             valor_padrao, aliquota_iss, iss_retido)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (empresa_id, apelido) DO UPDATE SET
         codigo_tributacao = EXCLUDED.codigo_tributacao, descricao = EXCLUDED.descricao,
         valor_padrao = EXCLUDED.valor_padrao, aliquota_iss = EXCLUDED.aliquota_iss,
         iss_retido = EXCLUDED.iss_retido, ativo = TRUE
       RETURNING *`,
      [b.empresaId, b.apelido, String(b.codigoTributacao), b.descricao,
       b.valorPadrao ?? null, b.aliquotaIss ?? null, b.issRetido === true]);
    res.status(201).json(r.rows[0]);
  } catch (e) { next(e); }
});

router.delete('/servico/:id', async (req, res, next) => {
  try {
    const dono = await db.query('SELECT empresa_id FROM servicos WHERE id = $1', [req.params.id]);
    if (!dono.rows.length || !empresaVisivel(req, dono.rows[0].empresa_id)) {
      return res.status(404).json({ erro: 'Serviço não encontrado' });
    }
    const r = await db.query(
      'UPDATE servicos SET ativo = FALSE WHERE id = $1 RETURNING id', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ erro: 'Serviço não encontrado' });
    res.status(204).end();
  } catch (e) { next(e); }
});

/* Registra o uso após emitir, para as sugestões refletirem o que é frequente. */
router.post('/registrar-uso', async (req, res, next) => {
  try {
    const b = req.body || {};
    // O `empresa_id = ANY(...)` no WHERE resolve o escopo sem uma consulta a
    // mais: fora dele, o UPDATE simplesmente não acha linha.
    const ids = empresasVisiveis(req);
    if (b.tomadorId) {
      await db.query(
        `UPDATE tomadores SET vezes_usado = vezes_usado + 1, ultimo_uso = now()
          WHERE id = $1 AND ($2::int[] IS NULL OR empresa_id = ANY($2::int[]))`,
        [b.tomadorId, ids]);
    }
    if (b.servicoId) {
      await db.query(
        `UPDATE servicos SET vezes_usado = vezes_usado + 1, ultimo_uso = now()
          WHERE id = $1 AND ($2::int[] IS NULL OR empresa_id = ANY($2::int[]))`,
        [b.servicoId, ids]);
    }
    res.status(204).end();
  } catch (e) { next(e); }
});

module.exports = router;
