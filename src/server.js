const express = require('express');
const config = require('./config');
const auth = require('./middleware/auth');
const empresasRouter = require('./routes/empresas');
const nfseRouter = require('./routes/nfse');

const app = express();
app.use(express.json({ limit: '2mb' }));

app.get('/health', (_req, res) => res.json({ ok: true, servico: 'nfse-gateway' }));

app.use(auth); // todas as rotas abaixo exigem X-API-Key
app.use('/empresas', empresasRouter);
app.use('/nfse', nfseRouter);

// tratamento central de erros
app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ erro: err.message || 'Erro interno' });
});

app.listen(config.port, () => {
  console.log(`nfse-gateway ouvindo na porta ${config.port}`);
});
