const db = require('../db');
const config = require('../config');
const { montarDps, gerarIdDps } = require('../nfse/dpsBuilder');
const { montarPedidoCancelamento } = require('../nfse/eventoBuilder');
const { assinarXml } = require('../nfse/assinador');
const sefin = require('../nfse/sefinClient');
const { carregarCertificadoAtivo } = require('./certificadoService');

async function buscarEmpresa(cnpj) {
  const r = await db.query('SELECT * FROM empresas WHERE cnpj = $1 AND ativo', [cnpj.replace(/\D/g, '')]);
  if (!r.rows.length) throw Object.assign(new Error('Empresa não encontrada ou inativa'), { status: 404 });
  return r.rows[0];
}

/* Reserva o próximo número de DPS da empresa (atômico). */
async function proximoNumero(empresaId) {
  const r = await db.query(
    'UPDATE empresas SET prox_num_dps = prox_num_dps + 1, atualizado_em = now() WHERE id = $1 RETURNING prox_num_dps - 1 AS numero',
    [empresaId]
  );
  return Number(r.rows[0].numero);
}

/**
 * Fluxo de emissão:
 * 1. Carrega empresa e certificado
 * 2. Reserva número, monta e assina a DPS
 * 3. Persiste como pendente, envia à Sefin Nacional
 * 4. Atualiza status com o resultado (autorizada/rejeitada/erro)
 */
async function emitir(cnpjEmpresa, dados) {
  const empresa = await buscarEmpresa(cnpjEmpresa);
  const cert = await carregarCertificadoAtivo(empresa.id);
  const amb = config.ambientes[empresa.ambiente];

  const serie = dados.serie || empresa.serie_dps;
  const numero = dados.numero || await proximoNumero(empresa.id);
  const idDps = gerarIdDps({
    codigoMunicipio: empresa.codigo_municipio,
    cnpj: empresa.cnpj,
    serie,
    numero
  });

  const dpsXml = montarDps(empresa, dados, {
    tpAmb: amb.tpAmb,
    verAplic: config.verAplic,
    idDps, serie, numero
  });
  const dpsAssinada = assinarXml(dpsXml, 'infDPS', cert);

  const nota = await db.query(
    `INSERT INTO notas (empresa_id, id_dps, serie, numero, status, dps_xml)
     VALUES ($1,$2,$3,$4,'pendente',$5) RETURNING id`,
    [empresa.id, idDps, serie, numero, dpsAssinada]
  );
  const notaId = nota.rows[0].id;

  let resp;
  try {
    resp = await sefin.enviarDps(empresa.ambiente, dpsAssinada, cert);
  } catch (e) {
    await db.query(
      `UPDATE notas SET status='erro', mensagens=$2, atualizado_em=now() WHERE id=$1`,
      [notaId, JSON.stringify({ erro: e.message })]
    );
    throw Object.assign(new Error('Falha de comunicação com a Sefin Nacional: ' + e.message), { status: 502 });
  }

  const autorizada = resp.status >= 200 && resp.status < 300 && resp.json && resp.json.chaveAcesso;
  await db.query(
    `UPDATE notas SET status=$2, chave_acesso=$3, nfse_xml=$4, mensagens=$5, atualizado_em=now() WHERE id=$1`,
    [
      notaId,
      autorizada ? 'autorizada' : 'rejeitada',
      autorizada ? resp.json.chaveAcesso : null,
      autorizada ? resp.json.nfseXml : null,
      JSON.stringify(resp.json ?? { httpStatus: resp.status, corpo: resp.raw })
    ]
  );

  return {
    notaId,
    idDps,
    serie,
    numero,
    status: autorizada ? 'autorizada' : 'rejeitada',
    httpStatus: resp.status,
    chaveAcesso: autorizada ? resp.json.chaveAcesso : undefined,
    nfseXml: autorizada ? resp.json.nfseXml : undefined,
    urlDanfse: autorizada ? sefin.urlDanfse(empresa.ambiente, resp.json.chaveAcesso) : undefined,
    retornoSefin: resp.json ?? resp.raw
  };
}

/* Consulta NFS-e na Sefin pela chave de acesso. */
async function consultar(cnpjEmpresa, chaveAcesso) {
  const empresa = await buscarEmpresa(cnpjEmpresa);
  const cert = await carregarCertificadoAtivo(empresa.id);
  const resp = await sefin.consultarNfse(empresa.ambiente, chaveAcesso, cert);
  return { httpStatus: resp.status, retornoSefin: resp.json ?? resp.raw };
}

/* Cancela NFS-e via evento e101101. */
async function cancelar(cnpjEmpresa, chaveAcesso, { codigoMotivo, motivo } = {}) {
  const empresa = await buscarEmpresa(cnpjEmpresa);
  const cert = await carregarCertificadoAtivo(empresa.id);
  const amb = config.ambientes[empresa.ambiente];

  const eventoXml = montarPedidoCancelamento({
    tpAmb: amb.tpAmb,
    verAplic: config.verAplic,
    chaveAcesso,
    cnpjAutor: empresa.cnpj,
    codigoMotivo: codigoMotivo || 1,
    motivo
  });
  const eventoAssinado = assinarXml(eventoXml, 'infPedReg', cert);

  const resp = await sefin.enviarEvento(empresa.ambiente, chaveAcesso, eventoAssinado, cert);
  const ok = resp.status >= 200 && resp.status < 300;

  if (ok) {
    await db.query(
      `UPDATE notas SET status='cancelada', atualizado_em=now() WHERE chave_acesso=$1`,
      [chaveAcesso]
    );
  }
  return { httpStatus: resp.status, cancelada: ok, retornoSefin: resp.json ?? resp.raw };
}

module.exports = { emitir, consultar, cancelar };
