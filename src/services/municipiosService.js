/* Classificação de municípios: Nacional (o gateway emite) vs. próprio (emissor
   municipal, ABRASF etc. — o gateway não emite).

   Duas formas de classificar:
   - automática: consulta o ADN com o certificado de uma empresa (classificar);
   - manual: a contabilidade marca direto (definirManual), útil antes de haver
     certificado, ou para municípios que a consulta ainda não cobre. */
const db = require('../db');
const parametros = require('../nfse/parametrosClient');
const { carregarCertificadoAtivo } = require('./certificadoService');

/* Interpreta a resposta da consulta em modo_emissao + conveniado.
 *
 * Regra deliberadamente conservadora: SÓ classifica como 'proprio' com
 * evidência positiva no corpo da resposta. Um 404 ou 501 significa apenas que
 * o endpoint não respondeu — pode ser rota inexistente naquele ambiente, e não
 * um município fora do Sistema Nacional.
 *
 * Isso importa porque 'proprio' BLOQUEIA a emissão: classificar errado
 * impediria de emitir num município que na verdade é Nacional. Testando com
 * certificado real, a produção restrita devolveu 501 (rota não implementada) —
 * a versão anterior desta função leu isso como "emissor próprio" e marcou
 * Curitiba como bloqueada. Na dúvida, 'desconhecido' (que não bloqueia). */
function classificarResposta(resp) {
  if (resp.status >= 200 && resp.status < 300 && resp.json) {
    // Alguns retornos trazem indicação explícita de não-convênio.
    const j = resp.json;
    const conveniadoExplicito = j.conveniado ?? j.municipioConveniado ?? j.aderente;
    if (conveniadoExplicito === false) {
      return { modo: 'proprio', conveniado: false };
    }
    return { modo: 'nacional', conveniado: true };
  }
  // 404, 501, 5xx, timeout: sem informação suficiente para classificar.
  return { modo: 'desconhecido', conveniado: null };
}

/* Extrai a alíquota de ISS de forma defensiva: o formato exato varia, então
   procura as chaves mais prováveis sem quebrar se nada casar. */
function extrairAliquota(aliquotasJson) {
  if (!aliquotasJson) return null;
  const cand = Array.isArray(aliquotasJson) ? aliquotasJson[0] : aliquotasJson;
  if (!cand || typeof cand !== 'object') return null;
  const v = cand.aliquota ?? cand.pAliq ?? cand.aliquotaIss ?? cand.valor;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function upsert(codigo, campos) {
  const cols = Object.keys(campos);
  const setList = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
  const insCols = ['codigo_municipio', ...cols].join(', ');
  const insVals = ['$1', ...cols.map((_, i) => `$${i + 2}`)].join(', ');
  const r = await db.query(
    `INSERT INTO municipios (${insCols}) VALUES (${insVals})
     ON CONFLICT (codigo_municipio) DO UPDATE SET ${setList}, atualizado_em = now()
     RETURNING *`,
    [codigo, ...cols.map(c => campos[c])]
  );
  return r.rows[0];
}

/* Consulta o ADN usando o certificado da empresa informada e grava o resultado.
   cnpjEmpresa é necessário só para obter um certificado válido para a chamada. */
async function classificar(codigoMunicipio, cnpjEmpresa, ambiente = 'homologacao') {
  const cod = String(codigoMunicipio).replace(/\D/g, '');
  if (!/^\d{7}$/.test(cod)) {
    throw Object.assign(new Error('codigoMunicipio deve ter 7 dígitos (IBGE)'), { status: 400 });
  }
  const emp = await db.query('SELECT id FROM empresas WHERE cnpj = $1', [String(cnpjEmpresa || '').replace(/\D/g, '')]);
  if (!emp.rows.length) throw Object.assign(new Error('Informe cnpjEmpresa com certificado para a consulta'), { status: 400 });
  const cert = await carregarCertificadoAtivo(emp.rows[0].id);

  const resp = await parametros.consultarParametros(ambiente, cod, cert);
  const { modo, conveniado } = classificarResposta(resp);

  let aliquota = null;
  if (modo === 'nacional') {
    try {
      const al = await parametros.consultarAliquotas(ambiente, cod, cert);
      aliquota = extrairAliquota(al.json);
    } catch (_) { /* alíquota é complementar; não falha a classificação */ }
  }

  return upsert(cod, {
    modo_emissao: modo,
    conveniado,
    aliquota_iss: aliquota,
    fonte: 'adn',
    parametros: JSON.stringify(resp.json ?? { httpStatus: resp.status }),
    consultado_em: new Date()
  });
}

/* Marcação manual pela contabilidade. */
async function definirManual(codigoMunicipio, dados = {}) {
  const cod = String(codigoMunicipio).replace(/\D/g, '');
  if (!/^\d{7}$/.test(cod)) {
    throw Object.assign(new Error('codigoMunicipio deve ter 7 dígitos (IBGE)'), { status: 400 });
  }
  if (dados.modoEmissao && !['nacional', 'proprio', 'desconhecido'].includes(dados.modoEmissao)) {
    throw Object.assign(new Error("modoEmissao deve ser 'nacional', 'proprio' ou 'desconhecido'"), { status: 400 });
  }
  const campos = { fonte: 'manual' };
  if (dados.modoEmissao) campos.modo_emissao = dados.modoEmissao;
  if (dados.nome !== undefined) campos.nome = dados.nome || null;
  if (dados.uf !== undefined) campos.uf = dados.uf ? String(dados.uf).toUpperCase() : null;
  if (dados.aliquotaIss !== undefined) campos.aliquota_iss = dados.aliquotaIss;
  return upsert(cod, campos);
}

async function obter(codigoMunicipio) {
  const cod = String(codigoMunicipio).replace(/\D/g, '');
  const r = await db.query('SELECT * FROM municipios WHERE codigo_municipio = $1', [cod]);
  return r.rows[0] || null;
}

async function listar() {
  const r = await db.query('SELECT * FROM municipios ORDER BY nome NULLS LAST, codigo_municipio');
  return r.rows;
}

/* Usado pela emissão: 'nacional' | 'proprio' | 'desconhecido'.
   Município ainda não cadastrado é tratado como 'desconhecido' (não bloqueia,
   para não travar emissão de municípios que já são Nacional mas ninguém
   classificou ainda). O bloqueio só acontece no 'proprio' explícito. */
async function modoDe(codigoMunicipio) {
  const m = await obter(codigoMunicipio);
  return m ? m.modo_emissao : 'desconhecido';
}

module.exports = { classificar, definirManual, obter, listar, modoDe };
