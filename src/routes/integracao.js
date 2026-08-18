const crypto = require('crypto');
const express = require('express');
const db = require('../db');
const { limparDocumento } = require('../util/documento');

const router = express.Router();

/* Base pública do gateway, usada nos exemplos entregues ao cliente.
   Configurável porque atrás de proxy o host do request não é o externo. */
function baseUrl(req) {
  return (process.env.GATEWAY_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}

function novoToken() {
  return crypto.randomBytes(24).toString('hex');
}

async function empresaPorCnpj(cnpj) {
  const r = await db.query('SELECT * FROM empresas WHERE cnpj = $1',
    [limparDocumento(cnpj)]);
  if (!r.rows.length) throw Object.assign(new Error('Empresa não encontrada'), { status: 404 });
  return r.rows[0];
}

/**
 * Pacote de integração da empresa: o que o setor de contabilidade entrega ao
 * sistema cliente para conectar. Reúne credenciais, endpoints e exemplos
 * prontos, para não ser preciso montar isso à mão a cada empresa nova.
 */
router.get('/:cnpj', async (req, res, next) => {
  try {
    const empresa = await empresaPorCnpj(req.params.cnpj);
    const base = baseUrl(req);

    const tk = await db.query(
      `SELECT ambiente, token, ativo, ultimo_uso, criado_em
         FROM empresa_tokens WHERE empresa_id = $1 ORDER BY ambiente`,
      [empresa.id]);

    const hooks = await db.query(
      `SELECT id, url, ambiente, header_autorizacao,
              (chave_autorizacao IS NOT NULL) AS tem_chave, ativo
         FROM webhooks
        WHERE ativo AND (empresa_id IS NULL OR empresa_id = $1)`,
      [empresa.id]);

    const tokenExemplo = (tk.rows.find(t => t.ambiente === empresa.ambiente) || tk.rows[0] || {}).token;

    res.json({
      empresa: {
        cnpj: empresa.cnpj,
        razaoSocial: empresa.razao_social,
        ambienteAtual: empresa.ambiente,
        certificadoOk: !!(await db.query(
          'SELECT 1 FROM certificados WHERE empresa_id=$1 AND ativo LIMIT 1', [empresa.id])).rows.length
      },
      baseUrl: base,
      autenticacao: {
        header: 'X-API-Key',
        observacao: 'O token define a empresa E o ambiente. Não é preciso enviar cnpjEmpresa nem ambiente no corpo — o gateway usa os do token.'
      },
      tokens: tk.rows.map(t => ({
        ambiente: t.ambiente,
        token: t.token,
        ativo: t.ativo,
        ultimoUso: t.ultimo_uso
      })),
      endpoints: {
        emitir:       { metodo: 'POST', url: `${base}/nfse` },
        consultarNota:{ metodo: 'GET',  url: `${base}/nfse/{chaveAcesso}` },
        listarNotas:  { metodo: 'GET',  url: `${base}/nfse?status=autorizada` },
        xmlNfse:      { metodo: 'GET',  url: `${base}/nfse/{chaveAcesso}/xml` },
        xmlDps:       { metodo: 'GET',  url: `${base}/nfse/{chaveAcesso}/xml-dps` },
        danfsePdf:    { metodo: 'GET',  url: `${base}/nfse/{chaveAcesso}/danfse` },
        cancelar:     { metodo: 'POST', url: `${base}/nfse/{chaveAcesso}/cancelamento` }
      },
      webhooks: hooks.rows,
      exemplo: {
        descricao: 'Emissão mínima. A resposta é 202 com o notaId; o resultado chega pelo webhook ou pela consulta.',
        curl:
          `curl -X POST ${base}/nfse \\\n` +
          `  -H "X-API-Key: ${tokenExemplo || '<TOKEN>'}" \\\n` +
          `  -H "Content-Type: application/json" \\\n` +
          `  -d '{\n` +
          `    "referencia": "PEDIDO-123",\n` +
          `    "tomador": { "cnpj": "00000000000191", "razaoSocial": "Cliente Exemplo SA" },\n` +
          `    "servico": { "codigoTributacaoNacional": "110201", "descricao": "Descricao do servico" },\n` +
          `    "valores": { "valorServico": 100.00 }\n` +
          `  }'`
      }
    });
  } catch (e) { next(e); }
});

/* Gera (ou regenera) o token de um ambiente.
   Regenerar invalida o anterior imediatamente — quem estiver usando para de
   funcionar até receber o novo. */
router.post('/:cnpj/tokens', async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!['producao', 'homologacao'].includes(b.ambiente)) {
      return res.status(400).json({ erro: "ambiente deve ser 'producao' ou 'homologacao'" });
    }
    const empresa = await empresaPorCnpj(req.params.cnpj);
    const token = novoToken();
    const r = await db.query(
      `INSERT INTO empresa_tokens (empresa_id, ambiente, token, descricao)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (empresa_id, ambiente)
       DO UPDATE SET token = EXCLUDED.token, ativo = TRUE,
                     descricao = EXCLUDED.descricao, criado_em = now(), ultimo_uso = NULL
       RETURNING ambiente, token, criado_em`,
      [empresa.id, b.ambiente, token, b.descricao || null]);
    res.status(201).json(r.rows[0]);
  } catch (e) { next(e); }
});

/* Desativa o token de um ambiente sem apagar o registro (mantém o histórico
   de uso). Reativar exige gerar um novo. */
router.delete('/:cnpj/tokens/:ambiente', async (req, res, next) => {
  try {
    const empresa = await empresaPorCnpj(req.params.cnpj);
    const r = await db.query(
      `UPDATE empresa_tokens SET ativo = FALSE
        WHERE empresa_id = $1 AND ambiente = $2 RETURNING ambiente`,
      [empresa.id, req.params.ambiente]);
    if (!r.rows.length) return res.status(404).json({ erro: 'Token não encontrado' });
    res.status(204).end();
  } catch (e) { next(e); }
});

module.exports = router;
