const path = require('path');
const express = require('express');
const config = require('./config');
const auth = require('./middleware/auth');
const empresasRouter = require('./routes/empresas');
const nfseRouter = require('./routes/nfse');
const webhooksRouter = require('./routes/webhooks');
const fila = require('./services/filaEmissao');
const webhooks = require('./services/webhooks');
const emailTomador = require('./services/emailTomador');

const app = express();
app.use(express.json({ limit: '2mb' }));

app.get('/health', (_req, res) => res.json({ ok: true, servico: 'nfse-gateway' }));

/* Painel de administração (empresas e certificados).
   A página em si não exige autenticação — é só o shell, sem dados nem segredos.
   Ela pede a chave de API no navegador e a envia em cada chamada às rotas abaixo,
   que continuam protegidas pelo middleware. */
app.get('/admin', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

app.use(auth); // todas as rotas abaixo exigem X-API-Key
app.use('/empresas', empresasRouter);
app.use('/nfse', nfseRouter);
app.use('/webhooks', webhooksRouter);

// tratamento central de erros
app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ erro: err.message || 'Erro interno' });
});

app.listen(config.port, () => {
  console.log(`nfse-gateway ouvindo na porta ${config.port}`);
  // O worker roda no mesmo processo. Como o estado da fila vive no banco e a
  // reivindicação usa FOR UPDATE SKIP LOCKED, subir várias instâncias do
  // gateway é seguro: cada worker pega notas diferentes.
  if (process.env.FILA_ATIVA !== 'false') fila.iniciar();
  if (process.env.WEBHOOK_ATIVO !== 'false') webhooks.iniciar();
  if (process.env.EMAIL_ATIVO !== 'false') emailTomador.iniciar();
});
