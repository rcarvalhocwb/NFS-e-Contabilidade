try { require('dotenv').config(); } catch (_) { /* dotenv opcional */ }

const AMBIENTES = {
  producao: {
    tpAmb: '1',
    sefinBaseUrl: 'https://sefin.nfse.gov.br/sefinnacional',
    adnBaseUrl: 'https://adn.nfse.gov.br',
    // Base dos endpoints de parâmetros municipais. Assumida igual à do Sefin
    // Nacional; confirmar contra o Manual dos Contribuintes (gov.br/nfse) com
    // um certificado real. Sobrescrevível por PARAMETROS_BASE_URL_PROD.
    parametrosBaseUrl: process.env.PARAMETROS_BASE_URL_PROD || 'https://sefin.nfse.gov.br/sefinnacional'
  },
  homologacao: {
    tpAmb: '2',
    sefinBaseUrl: 'https://sefin.producaorestrita.nfse.gov.br/SefinNacional',
    adnBaseUrl: 'https://adn.producaorestrita.nfse.gov.br',
    parametrosBaseUrl: process.env.PARAMETROS_BASE_URL_HOMOLOG || 'https://sefin.producaorestrita.nfse.gov.br/SefinNacional'
  }
};

const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  /* Trava de instalação: com PERMITIR_PRODUCAO=false, nenhuma nota sai em
     produção, mesmo que a empresa esteja marcada assim. Serve para a máquina de
     treinamento e para a de desenvolvimento — onde uma nota real emitida por
     engano teria valor fiscal e geraria imposto.
     O padrão é permitir: a instalação normal é para emitir de verdade. */
  permitirProducao: process.env.PERMITIR_PRODUCAO !== 'false',

  /* Um servidor atendendo vários escritórios de contabilidade, em vez de uma
     instalação de mesa atendendo um.

     Separa dois papéis que até aqui eram a mesma pessoa: o administrador do
     escritório e o operador do servidor. Ligado, as telas que mexem no
     servidor inteiro (endereço e certificado TLS, destinos de backup,
     reiniciar) passam a exigir a credencial de máquina — mexer nelas afeta
     todas as casas, não só a de quem clicou.

     Desligado por padrão: a instalação de mesa é o produto que roda hoje, e
     nela o administrador É o operador. */
  multiEscritorio: process.env.MULTI_ESCRITORIO === 'true',
  databaseUrl: process.env.DATABASE_URL,
  apiKey: process.env.GATEWAY_API_KEY,
  masterKey: process.env.MASTER_KEY,
  /* Vai dentro de toda DPS e identifica o aplicativo emissor. Ficou preso em
     "1.0" enquanto o gateway chegava à 1.6: num documento fiscal, dizer a
     versão errada atrapalha justamente quem for investigar um lote de notas
     com problema. Sai do package.json para não haver duas verdades. */
  verAplic: process.env.VER_APLIC ||
    ('nfse-gateway/' + require('../package.json').version),
  xmlSigAlg: (process.env.XML_SIG_ALG || 'sha1').toLowerCase(),
  ambientes: AMBIENTES,

  /* Atualizações. O repositório de releases é PÚBLICO e separado do código,
     que é privado: assim o gateway baixa sem token, e nenhuma credencial de
     acesso ao fonte precisa viajar dentro do instalador. */
  atualizacao: {
    repositorio: process.env.ATUALIZACAO_REPO || 'rcarvalhocwb/nfse-gateway-releases',
    // Sobrescreve o endereço inteiro, para quem publicar fora do GitHub
    url: process.env.ATUALIZACAO_URL || null,
    ativo: process.env.ATUALIZACAO_VERIFICAR !== 'false',
    intervaloHoras: Number(process.env.ATUALIZACAO_INTERVALO_HORAS || 6),
    timeoutMs: Number(process.env.ATUALIZACAO_TIMEOUT_MS || 8000),
    pasta: process.env.ATUALIZACAO_PASTA || require('path').join(process.cwd(), 'atualizacoes')
  }
};

/**
 * Confere a configuração antes de o servidor aceitar a primeira requisição.
 *
 * Sem isso, um .env incompleto só se manifesta no meio de uma emissão: a
 * MASTER_KEY ausente falha ao abrir o certificado, com a DPS já assinada e o
 * número fiscal queimado. Falhar na subida, com o nome do campo que falta, é a
 * diferença entre um erro que a contabilidade resolve sozinha e uma ligação.
 */
function validar() {
  const erros = [];
  const avisos = [];

  if (!config.databaseUrl) {
    erros.push('DATABASE_URL não definida — sem banco o gateway não sobe.');
  } else if (!/^postgres(ql)?:\/\//.test(config.databaseUrl)) {
    erros.push('DATABASE_URL deve começar com postgresql://');
  }

  if (!config.apiKey) {
    erros.push('GATEWAY_API_KEY não definida — é ela que autoriza o primeiro acesso.');
  } else if (config.apiKey.length < 24) {
    avisos.push('GATEWAY_API_KEY é curta; gere 24 bytes em hex.');
  }

  // 32 bytes em hex. Chave errada não dá erro na hora: só descobre quando o
  // certificado guardado não abrir mais — e aí não há como recuperá-lo.
  if (!config.masterKey) {
    erros.push('MASTER_KEY não definida — é ela que cifra o certificado A1 no banco.');
  } else if (!/^[0-9a-fA-F]{64}$/.test(config.masterKey)) {
    erros.push('MASTER_KEY deve ter 64 caracteres hexadecimais (32 bytes). ' +
               'Gere com: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  }

  if (!['sha1', 'sha256'].includes(config.xmlSigAlg)) {
    erros.push(`XML_SIG_ALG inválido (${config.xmlSigAlg}); use sha1 ou sha256.`);
  }

  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    erros.push(`PORT inválida (${process.env.PORT}).`);
  }

  if (process.env.NODE_ENV === 'production' && process.env.ADMIN_ATIVO !== 'false'
      && process.env.TRUST_PROXY === 'true') {
    avisos.push('Painel ativo atrás de proxy: garanta que o acesso esteja restrito ' +
                '(VPN ou IP), pois ele cadastra empresas e troca certificados.');
  }

  return { erros, avisos };
}

/* Encerra o processo quando falta o essencial. Subir "meio configurado" só adia
   o erro para o pior momento. */
function validarOuSair() {
  const { erros, avisos } = validar();

  if (!config.permitirProducao) {
    console.warn('[config] PERMITIR_PRODUCAO=false — emissão em produção bloqueada nesta instalação');
  }
  avisos.forEach(a => console.warn('[config] aviso:', a));

  if (erros.length) {
    console.error('\n  O gateway não pode iniciar. Corrija o arquivo .env:\n');
    erros.forEach(e => console.error('   - ' + e));
    console.error('\n  O arquivo .env fica na pasta do gateway.');
    console.error('  Use .env.example como referência.\n');
    process.exit(1);
  }
}

module.exports = Object.assign(config, { validar, validarOuSair });
