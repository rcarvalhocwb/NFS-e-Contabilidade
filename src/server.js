const path = require('path');
const express = require('express');
const config = require('./config');
const db = require('./db');
const auth = require('./middleware/auth');
const { somenteAdmin, fixarEscopoEmpresa } = require('./middleware/escopo');
const empresasRouter = require('./routes/empresas');
const nfseRouter = require('./routes/nfse');
const webhooksRouter = require('./routes/webhooks');
const municipiosRouter = require('./routes/municipios');
const consultaRouter = require('./routes/consulta');
const integracaoRouter = require('./routes/integracao');
const fila = require('./services/filaEmissao');
const webhooks = require('./services/webhooks');
const emailTomador = require('./services/emailTomador');

const app = express();

// Atrás de proxy reverso (nginx, Cloudflare, PaaS), o IP e o protocolo reais
// vêm nos headers X-Forwarded-*. Sem isso o gateway acha que toda requisição é
// HTTP local — e o aviso de "sem HTTPS" do painel nunca apareceria.
if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);

app.use(express.json({ limit: '2mb' }));

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

/* Painel de administração (empresas e certificados).
   A página em si não exige autenticação — é só o shell, sem dados nem segredos:
   ela pede a chave de API no navegador e a envia nas chamadas às rotas abaixo,
   que continuam protegidas pelo middleware.

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
  app.get('/admin', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
}

app.use(auth); // todas as rotas abaixo exigem X-API-Key

// Rotas de gestão: só a credencial administrativa. O token entregue ao
// sistema cliente não cadastra empresa nem troca certificado.
app.use('/empresas', somenteAdmin, empresasRouter);
app.use('/webhooks', somenteAdmin, webhooksRouter);
app.use('/municipios', somenteAdmin, municipiosRouter);
app.use('/consulta', somenteAdmin, consultaRouter);
app.use('/integracao', somenteAdmin, integracaoRouter);

// NFS-e: aberta ao token da empresa, restrita ao escopo dele.
app.use('/nfse', fixarEscopoEmpresa, nfseRouter);

// tratamento central de erros
app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ erro: err.message || 'Erro interno' });
});

const servidor = app.listen(config.port, () => {
  console.log(`nfse-gateway ouvindo na porta ${config.port}`);
  // O worker roda no mesmo processo. Como o estado da fila vive no banco e a
  // reivindicação usa FOR UPDATE SKIP LOCKED, subir várias instâncias do
  // gateway é seguro: cada worker pega notas diferentes.
  if (process.env.FILA_ATIVA !== 'false') fila.iniciar();
  if (process.env.WEBHOOK_ATIVO !== 'false') webhooks.iniciar();
  if (process.env.EMAIL_ATIVO !== 'false') emailTomador.iniciar();
});

/* Encerramento limpo. Em deploy, o orquestrador manda SIGTERM e mata o
   processo pouco depois: sem isso, uma nota poderia ficar com o lease preso
   (só liberado no timeout) e uma requisição em andamento seria cortada.
   Parar os workers primeiro evita reivindicar trabalho novo durante a saída. */
function encerrar(sinal) {
  console.log(`[shutdown] ${sinal} recebido, encerrando...`);
  fila.parar();
  webhooks.parar();
  emailTomador.parar();
  servidor.close(() => {
    db.pool.end()
      .then(() => { console.log('[shutdown] concluído'); process.exit(0); })
      .catch(() => process.exit(0));
  });
  // Rede de segurança: se algo travar, não fica pendurado indefinidamente.
  setTimeout(() => {
    console.error('[shutdown] tempo esgotado, saindo à força');
    process.exit(1);
  }, 10000).unref();
}
process.on('SIGTERM', () => encerrar('SIGTERM'));
process.on('SIGINT', () => encerrar('SIGINT'));
