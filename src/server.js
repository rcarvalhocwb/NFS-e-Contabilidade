const path = require('path');
const express = require('express');
const config = require('./config');

/* Antes de qualquer outra coisa: sem configuração válida o gateway não sobe, e
   o registro em arquivo precisa estar de pé para capturar o que vier depois. */
config.validarOuSair();
require('./services/registro').iniciar();
const db = require('./db');
const auth = require('./middleware/auth');
const inquilino = require('./middleware/inquilino');
const { somenteAdmin, fixarEscopoEmpresa } = require('./middleware/escopo');
const { conferirOrigem, cabecalhosSeguranca } = require('./middleware/protecao');
const empresasRouter = require('./routes/empresas');
const nfseRouter = require('./routes/nfse');
const webhooksRouter = require('./routes/webhooks');
const municipiosRouter = require('./routes/municipios');
const consultaRouter = require('./routes/consulta');
const integracaoRouter = require('./routes/integracao');
const painelRouter = require('./routes/painel');
const atualizacaoRouter = require('./routes/atualizacao');
const identidadeRouter = require('./routes/identidade');
const emailRouter = require('./routes/email');
const ponteRouter = require('./routes/ponte');
const identidadeServico = require('./services/identidade');
const obrigacoesRouter = require('./routes/obrigacoes');
const emissorRouter = require('./routes/emissor');
const authRouter = require('./routes/auth');
const usuariosRouter = require('./routes/usuarios');
const manutencaoRouter = require('./routes/manutencao');
const loteRouter = require('./routes/lote');
const relatoriosRouter = require('./routes/relatorios');
const notasEntradaRouter = require('./routes/notasEntrada');
const licencaRouter = require('./routes/licenca');
const sessoes = require('./services/sessoes');
const fila = require('./services/filaEmissao');
const atualizacao = require('./services/atualizacao');
const webhooks = require('./services/webhooks');
const emailTomador = require('./services/emailTomador');
const backupAutomatico = require('./services/backupAutomatico');

const app = express();

// Atrás de proxy reverso (nginx, Cloudflare, PaaS), o IP e o protocolo reais
// vêm nos headers X-Forwarded-*. Sem isso o gateway acha que toda requisição é
// HTTP local — e o aviso de "sem HTTPS" do painel nunca apareceria.
if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);

app.use(cabecalhosSeguranca);
/* Cabeçalhos de segurança.
   O gateway não fica exposto à internet, mas o painel abre num navegador que
   abre outras páginas — e é daí que vêm clickjacking e sniffing de tipo. */
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  // Sem CDN nem script externo: tudo que a página carrega vem daqui mesmo.
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
    "script-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  next();
});

app.use(express.json({ limit: '2mb' }));
app.use(conferirOrigem);

/* De quem é esta requisição — antes de tudo que lê dado.
   Precisa vir antes de `auth`, não depois: `auth` consulta `sessoes` e
   `empresa_tokens`, que estão sob policy de RLS e não respondem a conexão sem
   inquilino. Credencial não reconhecida passa adiante sem escritório, e sem
   escritório as tabelas de cliente devolvem zero linha — quem decide o 401 é
   o `auth`, que sabe dar a mensagem certa. */
app.use(inquilino);

// Arquivos da interface (CSS). Ficam antes da autenticacao: sao estaticos,
// sem dados nem segredos — as rotas de dados seguem protegidas.
/* Sem cache por tempo: os arquivos não são versionados, então um `maxAge` longo
   faz o operador continuar vendo a versão antiga do painel depois de atualizar
   o gateway. O ETag resolve com um 304 barato — é tudo local mesmo. */
app.use('/assets', express.static(path.join(__dirname, 'public'), { etag: true, maxAge: 0 }));

app.get('/health', (_req, res) => res.json({ ok: true, servico: 'nfse-gateway' }));

/* Raiz: quem abre o endereço no navegador quer o painel, não um JSON de erro
   de autenticação. Requisições de API (que pedem JSON) recebem um índice dos
   endpoints em vez do redirecionamento. */
app.get('/', (req, res) => {
  const querJson = (req.get('Accept') || '').includes('application/json');
  if (querJson || process.env.ADMIN_ATIVO === 'false') {
    return res.json({
      servico: 'nfse-gateway',
      documentacao: 'https://github.com/rcarvalhocwb/nfse-gateway',
      endpoints: {
        health: 'GET /health',
        emitir: 'POST /nfse',
        consultar: 'GET /nfse/{chaveAcesso}',
        xml: 'GET /nfse/{chaveAcesso}/xml',
        danfse: 'GET /nfse/{chaveAcesso}/danfse',
        cancelar: 'POST /nfse/{chaveAcesso}/cancelamento'
      },
      autenticacao: 'header X-API-Key'
    });
  }
  res.redirect('/admin');
});

/* Login e primeiro acesso: ficam antes do middleware de auth, porque quem vai
   entrar ainda não tem credencial. Cada rota se protege por conta própria. */
app.use('/auth', authRouter);

/* A marca do escritório é pública: a tela de acesso a mostra antes de existir
   sessão. São nome, cor e logo — nada que já não esteja no papel timbrado. */
/* De quem é a marca, antes de existir sessão.
 *
 * Com sessão, o middleware de inquilino já amarrou e não há o que decidir.
 * Sem sessão, há duas situações e elas não se parecem:
 *
 *   uma casa só  — é a instalação de mesa. A marca na tela de acesso é dela,
 *                  e tirá-la deixaria o painel com cara de meio instalado.
 *
 *   várias casas — não dá para saber de quem é a tela. Qualquer escolha é um
 *                  chute, e o chute mostra o nome e a cor de um cliente a
 *                  quem nem fez login. Melhor tela sem marca que tela com a
 *                  marca do vizinho.
 *
 * Antes isto nem era uma decisão: a consulta sem inquilino pegava a conexão
 * que o pool tivesse à mão e lia com o `app.escritorio` de quem a usou antes.
 * A tela de acesso mostrava a marca de um escritório sorteado pelo pool.
 */
async function marcaPublica(req, fn) {
  if (req.escritorioId) return fn();               // tem sessão: já amarrado
  if (config.multiEscritorio) return null;         // várias casas: não chuta

  const r = await db.comServidor(() => db.query(
    'SELECT * FROM escritorios_ativos() AS id'));
  if (r.rows.length !== 1) return null;            // zero ou várias: idem
  return db.comInquilino(r.rows[0].id, fn);
}

app.get('/marca', async (req, res) => {
  try {
    const i = (await marcaPublica(req, () => identidadeServico.ler())) || {};
    res.json({ nome: i.nome || null, descricao: i.descricao || null,
               corAcento: i.cor_acento || null, temLogo: !!i.tem_logo });
  } catch (e) {
    // Sem banco, o painel abre com a identidade padrão em vez de não abrir
    res.json({ nome: null, descricao: null, corAcento: null, temLogo: false });
  }
});

app.get('/marca/logo', async (req, res) => {
  try {
    const logo = await marcaPublica(req, () => identidadeServico.lerLogo());
    if (!logo) return res.status(404).end();
    res.setHeader('Content-Type', logo.tipo);
    // Curto de propósito: trocar a logo e ver a antiga por uma hora seria pior
    // que baixá-la de novo a cada cinco minutos.
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(logo.conteudo);
  } catch (e) { res.status(404).end(); }
});

/* Painel de administração (empresas e certificados).
   A página em si não exige autenticação — é só o shell, sem dados nem segredos:
   quem entra faz login com usuário e senha, e as rotas de dados abaixo seguem
   protegidas pelo middleware.

   Ainda assim, em produção o painel é a porta de entrada para cadastrar
   empresas e trocar certificados. Publicá-lo na internet aberta amplia a
   superfície de ataque sem necessidade: prefira mantê-lo atrás de VPN ou
   restrição de IP, ou desligá-lo com ADMIN_ATIVO=false e administrar por um
   túnel/acesso interno. */
if (process.env.ADMIN_ATIVO === 'false') {
  console.log('[admin] painel desativado por ADMIN_ATIVO=false');
  // Responde explicitamente, senão a rota cairia no middleware de auth e
  // devolveria 401 — que sugere problema de credencial, não recurso desligado.
  app.get('/admin', (_req, res) =>
    res.status(404).json({ erro: 'Painel desativado neste servidor (ADMIN_ATIVO=false)' }));
} else {
  /* As telas nunca vêm do cache.
     Depois de uma atualização, o navegador servia a versão antiga por conta
     própria e o escritório continuava vendo a tela de ontem — sem erro nenhum,
     só um sistema que "não mudou". Revalidar sempre custa um 304 numa rede
     local. */
  app.use(['/admin', '/emitir', '/nota'], (_req, res, next) => {
    res.set('Cache-Control', 'no-cache, must-revalidate');
    next();
  });
  app.get('/admin', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
  // Duas formas de emitir sem sistema integrado, para dois jeitos de trabalhar:
  // a conversa guia quem emite de vez em quando; o formulário mostra tudo de
  // uma vez, para quem emite em série.
  app.get('/emitir', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'emitir.html')));
  app.get('/nota', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'nota.html')));
}

/* O cadastro para o ensaio local.
 *
 * Fica ANTES da autenticação do painel porque quem chama não é uma pessoa
 * logada: é o `relay/ensaio.js`, rodando na mesma máquina para mostrar a
 * conversa do WhatsApp funcionando antes de existir servidor e número.
 *
 * A credencial é a chave da ponte — a mesma do repassador, e o dado devolvido é
 * exatamente o que o repassador já recebe. Nada aqui abre nada novo: sem a
 * chave, 401; com ela, o que o outro lado teria de todo jeito.
 */
app.get('/ponte/cadastro/previa-ensaio', async (req, res, next) => {
  try {
    const ponte = require('./services/ponteNuvem');
    const chave = await ponte.chave().catch(() => null);
    const cabecalho = String(req.headers.authorization || '');
    const esperado = 'Bearer ' + chave;
    if (!chave || cabecalho.length !== esperado.length ||
        !require('crypto').timingSafeEqual(Buffer.from(cabecalho), Buffer.from(esperado))) {
      return res.status(401).json({ erro: 'chave da ponte inválida' });
    }
    res.json(await require('./services/replicaCadastro').montar());
  } catch (e) { next(e); }
});

app.use(auth); // daqui para baixo: sessão de usuário ou X-API-Key

// Gestão do próprio gateway: administrador apenas. Quem só emite nota não
// troca o certificado A1, não mexe na numeração fiscal e não gera token.
app.use('/webhooks', somenteAdmin, webhooksRouter);
app.use('/municipios', somenteAdmin, municipiosRouter);
app.use('/integracao', somenteAdmin, integracaoRouter);

// Empresas: a leitura é liberada e filtrada pelas empresas visíveis (o operador
// precisa escolher a empresa para emitir); a escrita é barrada dentro do router.
app.use('/empresas', empresasRouter);

// Operação do dia a dia: qualquer usuário logado, sempre dentro do seu escopo.
app.use('/consulta', consultaRouter);
app.use('/emissor', emissorRouter);
app.use('/painel', painelRouter);
app.use('/atualizacao', atualizacaoRouter);
app.use('/obrigacoes', obrigacoesRouter);
app.use('/identidade', identidadeRouter);
app.use('/email', emailRouter);
app.use('/ponte', ponteRouter);
app.use('/usuarios', usuariosRouter);
app.use('/manutencao', manutencaoRouter);
app.use('/lote', loteRouter);
app.use('/relatorios', relatoriosRouter);

/* Licença: a leitura é de todo mundo logado (quem opera precisa ver que está
   vencendo), a escrita se protege dentro do router. */
app.use('/licenca', licencaRouter);
/* Importar uma pasta manda dezenas de XMLs de uma vez. O limite geral de 2 MB
   daria uns 250 documentos e cortaria o lote no meio, sem dizer por quê. */
app.use('/notas-entrada', express.json({ limit: '25mb' }), notasEntradaRouter);

// NFS-e: aberta ao token da empresa, restrita ao escopo dele.
app.use('/nfse', fixarEscopoEmpresa, nfseRouter);

// tratamento central de erros
app.use((err, _req, res, _next) => {
  /* Erro do multer é problema do envio, não do servidor: arquivo grande demais,
     campo com outro nome, arquivos a mais. Sem isto, subir um certificado no
     campo errado devolvia 500 — e "erro interno do servidor" manda a pessoa
     procurar ajuda em vez de olhar o próprio formulário. */
  if (err && err.name === 'MulterError') {
    const explicacao = {
      LIMIT_FILE_SIZE: 'O arquivo é grande demais para este envio.',
      LIMIT_FILE_COUNT: 'Arquivos demais de uma vez.',
      LIMIT_UNEXPECTED_FILE: 'O arquivo veio num campo que esta tela não espera.'
    }[err.code];
    return res.status(400).json({
      erro: explicacao || 'Não foi possível receber o arquivo enviado.',
      detalhe: err.code
    });
  }
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ erro: err.message || 'Erro interno' });
});

/* De onde o gateway aceita conexão, e se ela é criptografada.
 *
 * Isso morava só na variável HOST do .env. Agora vem da tela "Rede e conexão",
 * porque editar arquivo de configuração no bloco de notas é onde o operador de
 * contabilidade trava — e onde alguém apaga uma linha sem querer.
 *
 * A VARIÁVEL DE AMBIENTE CONTINUA VENCENDO, e é de propósito: numa máquina em
 * que o painel ficou inalcançável por configuração errada, `HOST=127.0.0.1` na
 * linha de comando é o jeito de voltar a entrar sem precisar do painel — que é
 * justamente o que não abre.
 *
 * O servidor sobe DEPOIS de ler a configuração, e sobe mesmo se ela falhar: um
 * gateway que não abre por causa do banco não consegue nem mostrar o erro. */
let servidor;
let servidorHttps = null;

async function subir() {
  const rede = await require('./services/configRede').paraSubir();

  servidor = app.listen(config.port, rede.host, aoSubir);

  if (rede.https) {
    /* HTTP e HTTPS juntos, em portas diferentes. Derrubar o HTTP ao ligar o
       HTTPS tiraria do ar o atalho da área de trabalho e todo endereço que
       alguém já anotou — inclusive o do repassador e o do monitor. */
    try {
      servidorHttps = require('https')
        .createServer({ cert: rede.https.cert, key: rede.https.key }, app)
        .listen(rede.https.porta, rede.host, () => {
          console.log('nfse-gateway tambem em https na porta ' + rede.https.porta);
        });
      servidorHttps.on('error', e =>
        console.error('[https] não consegui subir na porta ' +
          rede.https.porta + ': ' + e.message));
    } catch (e) {
      console.error('[https] certificado recusado pelo sistema: ' + e.message);
    }
  }
}

/* MULTI_ESCRITORIO é explícito de propósito — autorização que muda sozinha
   quando alguém cadastra uma linha é autorização que ninguém prevê. O preço
   de ser explícito é poder ficar esquecido, e esquecido aqui significa que o
   administrador de qualquer escritório continua podendo trocar o certificado
   TLS do servidor, mexer nos destinos de backup em disco e reiniciar o painel
   de todas as casas. Então o servidor confere e avisa alto, uma vez. */
async function conferirModoDeOperacao() {
  if (config.multiEscritorio) return;
  try {
    const r = await db.comServidor(() => db.query(
      'SELECT count(*)::int AS n FROM escritorios_ativos()'));
    if (r.rows[0].n > 1) {
      console.warn(`[aviso] ${r.rows[0].n} escritórios ativos e ` +
        'MULTI_ESCRITORIO não está ligado. O administrador de qualquer um ' +
        'deles pode trocar o certificado TLS do servidor, mexer nos destinos ' +
        'de backup e reiniciar o painel de todos. Ponha MULTI_ESCRITORIO=true ' +
        'no .env para que essas telas passem a exigir a credencial de máquina.');
    }
  } catch (e) {
    // Banco fora do ar na subida já é avisado em outro lugar; não repetir.
  }
}

function aoSubir() {
  console.log(`nfse-gateway ouvindo na porta ${config.port}`);
  conferirModoDeOperacao();
  // O worker roda no mesmo processo. Como o estado da fila vive no banco e a
  // reivindicação usa FOR UPDATE SKIP LOCKED, subir várias instâncias do
  // gateway é seguro: cada worker pega notas diferentes.
  if (process.env.FILA_ATIVA !== 'false') fila.iniciar();
  if (process.env.WEBHOOK_ATIVO !== 'false') webhooks.iniciar();
  if (process.env.EMAIL_ATIVO !== 'false') emailTomador.iniciar();
  if (process.env.BACKUP_ATIVO !== 'false') backupAutomatico.iniciar();
  atualizacao.iniciarVerificacaoPeriodica();

  /* Gera as ocorrências de obrigações à frente. Idempotente: rodar de novo não
     duplica nem mexe no que já foi concluído. */
  if (process.env.RESUMO_ATIVO !== 'false') require('./services/resumoPrazos').iniciar();
  if (process.env.PONTE_ATIVA !== 'false') require('./services/ponteNuvem').iniciar();
  /* O repassador do WhatsApp, quando o escritorio escolheu roda-lo aqui.
     Uma instalacao, uma atualizacao, um lugar so para olhar o log. */
  require('./services/repassadorLocal').iniciar()
    .catch(e => console.warn('[repassador]', e.message));
  /* Certificado vencendo, backup só no mesmo disco, painel aberto na rede:
     coisas que só se descobrem no pior momento se ninguém as disser. */
  require('./services/avisosProducao').iniciar();

  require('./services/obrigacoes').gerar({ meses: 3 })
    .then(r => { if (r.criadas) console.log(`[obrigacoes] ${r.criadas} ocorrência(s) criada(s)`); })
    .catch(e => console.warn('[obrigacoes] geração falhou:', e.message));
}

subir().catch(e => {
  console.error('[rede] não consegui ler a configuração:', e.message);
  servidor = app.listen(config.port, process.env.HOST || '0.0.0.0', aoSubir);
});

/* Sessões expiradas se acumulariam para sempre. De hora em hora basta: elas já
   não autenticam ninguém desde o instante em que venceram. */
const limpezaSessoes = setInterval(() => {
  sessoes.limparExpiradas()
    .catch(e => console.error('[sessoes] falha na limpeza:', e.message));
}, 3600 * 1000);
limpezaSessoes.unref();

/* Encerramento limpo. Em deploy, o orquestrador manda SIGTERM e mata o
   processo pouco depois: sem isso, uma nota poderia ficar com o lease preso
   (só liberado no timeout) e uma requisição em andamento seria cortada.
   Parar os workers primeiro evita reivindicar trabalho novo durante a saída. */
function encerrar(sinal) {
  console.log(`[shutdown] ${sinal} recebido, encerrando...`);
  fila.parar();
  webhooks.parar();
  emailTomador.parar();
  backupAutomatico.parar();
  require('./services/repassadorLocal').parar();
  require('./services/avisosProducao').parar();
  /* Os dois, e tolerando que ainda não existam: um sinal que chegue antes de a
     configuração de rede ser lida encontraria `servidor` indefinido, e o
     encerramento morreria com TypeError em vez de fechar o banco. */
  if (servidorHttps) servidorHttps.close();
  const fecharBanco = () => db.pool.end()
    .then(() => { console.log('[shutdown] concluído'); process.exit(0); })
    .catch(() => process.exit(0));
  if (servidor) servidor.close(fecharBanco); else fecharBanco();
  // Rede de segurança: se algo travar, não fica pendurado indefinidamente.
  setTimeout(() => {
    console.error('[shutdown] tempo esgotado, saindo à força');
    process.exit(1);
  }, 10000).unref();
}
process.on('SIGTERM', () => encerrar('SIGTERM'));
process.on('SIGINT', () => encerrar('SIGINT'));
