const db = require('../db');
const { limparDocumento } = require('../util/documento');
const config = require('../config');
const { montarDps, gerarIdDps } = require('../nfse/dpsBuilder');
const { conferirEmissao, conferirCancelamento } = require('../nfse/regrasDps');
const { aplicarPadroes } = require('../nfse/padroesEmpresa');
const emissorMunicipal = require('../nfse/emissorMunicipal');
const { montarPedidoCancelamento } = require('../nfse/eventoBuilder');
const { assinarXml } = require('../nfse/assinador');
const sefin = require('../nfse/sefinClient');
const { carregarCertificadoAtivo } = require('./certificadoService');
const municipios = require('./municipiosService');

async function buscarEmpresa(cnpj) {
  const r = await db.query('SELECT * FROM empresas WHERE cnpj = $1 AND ativo', [limparDocumento(cnpj)]);
  if (!r.rows.length) throw Object.assign(new Error('Empresa não encontrada ou inativa'), { status: 404 });
  return r.rows[0];
}

/* A IM do prestador vai na DPS?
   A Sefin valida contra o CNC do município emissor e recusa nos dois sentidos:
   E0116 quando falta, E0120 quando sobra. O padrão observado é enviar em
   homologação e omitir em produção — foi assim em Curitiba e é o que o CNC
   costuma responder, já que a produção restrita tem cadastro de teste e a
   produção só tem os municípios que registraram informações complementares.
   A tabela existe para o município que fugir disso: regra gravada vence. */
async function omitirIm(empresa, ambiente) {
  const r = await db.query(
    'SELECT exige_im FROM regra_im_dps WHERE codigo_municipio = $1 AND ambiente = $2',
    [empresa.codigo_municipio, ambiente]);
  if (r.rows.length) return !r.rows[0].exige_im;
  return ambiente === 'producao';
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
async function emitir(cnpjEmpresa, dadosRecebidos, contexto = {}) {
  const empresa = await buscarEmpresa(cnpjEmpresa);

  /* Os padrões da empresa, aplicados AQUI e não na tela.
   *
   * Moravam em `nota.js` e `emitir.js`, no navegador. Quem emitia por outro
   * caminho — WhatsApp, portal, `POST /nfse` — mandava só o que tinha, e a nota
   * de empresa do Simples saía sem <totTrib>: E1235, esquema incompleto. Com a
   * aplicação aqui, os quatro caminhos passam a valer o mesmo.
   *
   * O que o chamador informou continua vencendo: isto só preenche buraco. */
  const dados = aplicarPadroes(empresa, dadosRecebidos);

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

  /* Para onde esta nota vai, e se pode ir.
   *
   * Município no Sistema Nacional segue pela Sefin, como sempre. Município com
   * provedor próprio que aceita o layout nacional — o Betha de Fazenda Rio
   * Grande — segue pelo endereço dele, com a MESMA DPS. Emissor próprio sem
   * provedor implementado continua bloqueado, com o nome do lugar e para onde
   * ir.
   *
   * A conferência acontece ANTES de reservar número: uma recusa depois da
   * reserva deixaria buraco na sequência fiscal. */
  const mun = await municipios.obter(empresa.codigo_municipio);
  const impedimento = emissorMunicipal.conferirPodeEmitir(mun, empresa);
  if (impedimento) throw Object.assign(new Error(impedimento), { status: 422 });

  /* Conferência do leiaute ANTES de reservar número. A Sefin só recusaria
     depois de a numeração ter sido consumida e a DPS assinada — deixando um
     buraco na sequência fiscal por um e-mail longo demais ou uma alíquota que
     não cabe no campo. */
  conferirEmissao(dados);

  const cert = await carregarCertificadoAtivo(empresa.id);
  /* Trava da instalação, conferida antes de reservar número: numa máquina de
     treinamento a nota não pode escapar para produção nem por engano. */
  if (empresa.ambiente === 'producao' && !config.permitirProducao) {
    throw Object.assign(
      new Error('Esta instalação está com a emissão em produção bloqueada ' +
                '(PERMITIR_PRODUCAO=false no .env). Use homologação ou libere no servidor.'),
      { status: 403 });
  }

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

  const dpsXml = montarDps(
    Object.assign({}, empresa, { omitir_im: await omitirIm(empresa, empresa.ambiente) }),
    dados,
    { tpAmb: amb.tpAmb, verAplic: config.verAplic, idDps, serie, numero });
  const dpsAssinada = assinarXml(dpsXml, 'infDPS', cert);

  let nota;
  try {
    const emailTomador = (dados.tomador && dados.tomador.email) || null;
    const substituiChave = (dados.substituicao && dados.substituicao.chaveSubstituida) || null;
    nota = await db.query(
      `INSERT INTO notas (empresa_id, id_dps, serie, numero, status, dps_xml, referencia, ambiente,
                          tomador_email, substitui_chave, usuario_id)
       VALUES ($1,$2,$3,$4,'processando',$5,$6,$7,$8,$9,$10) RETURNING id`,
      [empresa.id, idDps, serie, numero, dpsAssinada, dados.referencia || null, empresa.ambiente,
       emailTomador, substituiChave, contexto.usuarioId || null]
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

/* Eventos registrados na Sefin para uma NFS-e. O gateway sabe dos eventos que
   ele enviou; esta é a lista da Sefin, que inclui o que veio por outro caminho. */
async function consultarEventos(cnpjEmpresa, chaveAcesso) {
  const empresa = await buscarEmpresa(cnpjEmpresa);
  const cert = await carregarCertificadoAtivo(empresa.id);
  const resp = await sefin.consultarEventos(empresa.ambiente, chaveAcesso, cert);
  return { httpStatus: resp.status, retornoSefin: resp.json ?? resp.raw };
}

/* Cancela NFS-e via evento e101101. */
async function cancelar(cnpjEmpresa, chaveAcesso, { codigoMotivo, motivo } = {}) {
  conferirCancelamento({ codigoMotivo, motivo });
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

module.exports = { emitir, consultar, consultarEventos, cancelar };
