const config = require('../config');

module.exports = function auth(req, res, next) {
  const key = req.header('X-API-Key');
  if (!config.apiKey) {
    return res.status(500).json({ erro: 'GATEWAY_API_KEY não configurada no servidor' });
  }
  if (key !== config.apiKey) {
    return res.status(401).json({ erro: 'API key inválida' });
  }
  next();
};
