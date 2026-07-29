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

/* Reserva o próximo número de DPS da empresa NO AMBIENTE informado (atômico).
   A numeração é independente por ambiente: o contador de homologação não pode
   consumir números da sequência de produção. */
async function reservarNumeracao(empresaId, ambiente) {
  const r = await db.query(
    `INSERT INTO numeracao_dps (empresa_id, ambiente, prox_numero)
     VALUES ($1, $2, 2)
     ON CONFLICT (empresa_id, ambiente) DO UPDATE
       SET prox_numero = numeracao_dps.prox_numero + 1, atualizado_em = now()
     RETURNING serie, prox_numero - 1 AS numero`,
    [empresaId, ambiente]
  );
  return { serie: r.rows[0].serie, numero: Number(r.rows[0].numero) };
}

/* Idempotência: se a empresa já emitiu com esta referência, devolve a nota
   existente em vez de gerar outra. Protege contra retry após timeout. */
async function buscarPorReferencia(empresaId, referencia) {
  if (!referencia) return null;
  const r = await db.query(
    `SELECT id, id_dps, serie, numero, status, chave_acesso, nfse_xml, ambiente, mensagens
     FROM notas WHERE empresa_id = $1 AND referencia = $2`,
    [empresaId, referencia]
  );
  return r.rows[0] || null;
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

  // Idempotência antes de qualquer efeito colateral: se já existe nota com
  // esta referência, devolve a que existe sem reservar número nem transmitir.
  const jaExiste = await buscarPorReferencia(empresa.id, dados.referencia);
  if (jaExiste) {
    return {
      notaId: jaExiste.id,
      idDps: jaExiste.id_dps,
      serie: jaExiste.serie,
      numero: Number(jaExiste.numero),
      status: jaExiste.status,
      ambiente: jaExiste.ambiente,
      chaveAcesso: jaExiste.chave_acesso || undefined,
      nfseXml: jaExiste.nfse_xml || undefined,
      urlDanfse: jaExiste.chave_acesso
        ? sefin.urlDanfse(jaExiste.ambiente, jaExiste.chave_acesso) : undefined,
      idempotente: true,
      retornoSefin: jaExiste.mensagens
    };
  }

  const cert = await carregarCertificadoAtivo(empresa.id);
  const amb = config.ambientes[empresa.ambiente];

  const reserva = dados.numero
    ? { serie: dados.serie, numero: dados.numero }
    : await reservarNumeracao(empresa.id, empresa.ambiente);
  const serie = dados.serie || reserva.serie;
  const numero = reserva.numero;
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

  let nota;
  try {
    const emailTomador = (dados.tomador && dados.tomador.email) || null;
    nota = await db.query(
      `INSERT INTO notas (empresa_id, id_dps, serie, numero, status, dps_xml, referencia, ambiente, tomador_email)
       VALUES ($1,$2,$3,$4,'processando',$5,$6,$7,$8) RETURNING id`,
      [empresa.id, idDps, serie, numero, dpsAssinada, dados.referencia || null, empresa.ambiente, emailTomador]
    );
  } catch (e) {
    // 23505 = unique_violation: corrida entre duas requisições com a mesma
    // referência. Devolve a nota que venceu a corrida, em vez de duplicar.
    if (e.code === '23505') {
      const existente = await buscarPorReferencia(empresa.id, dados.referencia);
      if (existente) {
        return {
          notaId: existente.id, idDps: existente.id_dps, serie: existente.serie,
          numero: Number(existente.numero), status: existente.status,
          ambiente: existente.ambiente,
          chaveAcesso: existente.chave_acesso || undefined,
          idempotente: true, retornoSefin: existente.mensagens
        };
      }
    }
    throw e;
  }
  const notaId = nota.rows[0].id;

  // A transmissão à Sefin fica por conta do worker (services/filaEmissao.js).
  // Até aqui só houve trabalho local (montar e assinar), então a resposta é
  // rápida e previsível mesmo com a Sefin lenta ou fora do ar.
  return {
    notaId,
    idDps,
    serie,
    numero,
    referencia: dados.referencia || undefined,
    ambiente: empresa.ambiente,
    status: 'processando',
    acompanhe: `/nfse/local/${notaId}`
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
