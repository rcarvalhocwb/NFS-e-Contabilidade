/* Proteções de borda do gateway.
   Sem dependência: o que é preciso aqui cabe em memória e em duas conferências
   de header — e uma dependência a menos é uma a menos para atualizar numa
   máquina que ninguém audita. */

/* ------------------------------------------------------- tentativas de senha */

/* Contador em memória, por IP+e-mail. Reiniciar o gateway zera, e isso é
   aceitável: o objetivo é frear script de força bruta, não resistir a um
   atacante com acesso à máquina — quem tem acesso local já tem o .env. */
const tentativas = new Map();

const LIMITE = 8;
const JANELA_MS = 15 * 60 * 1000;
const BLOQUEIO_MS = 15 * 60 * 1000;

function chaveTentativa(req) {
  const email = String((req.body && req.body.email) || '').toLowerCase().slice(0, 120);
  return `${req.ip}|${email}`;
}

function limparAntigas(agora) {
  for (const [chave, reg] of tentativas) {
    if (agora - reg.primeira > JANELA_MS && (!reg.bloqueadoAte || agora > reg.bloqueadoAte)) {
      tentativas.delete(chave);
    }
  }
}

/* Barra o login quando há tentativas demais. Aplicado antes de conferir a
   senha: sem isso, um script tenta senhas indefinidamente, e cada tentativa
   custa um scrypt (que é lento de propósito) do lado do servidor. */
function limitarLogin(req, res, next) {
  const agora = Date.now();
  if (tentativas.size > 500) limparAntigas(agora);

  const chave = chaveTentativa(req);
  const reg = tentativas.get(chave);

  if (reg && reg.bloqueadoAte && agora < reg.bloqueadoAte) {
    const minutos = Math.ceil((reg.bloqueadoAte - agora) / 60000);
    return res.status(429).json({
      erro: `Muitas tentativas. Tente de novo em ${minutos} minuto(s).`
    });
  }
  next();
}

function registrarFalhaLogin(req) {
  const agora = Date.now();
  const chave = chaveTentativa(req);
  const reg = tentativas.get(chave);

  if (!reg || agora - reg.primeira > JANELA_MS) {
    tentativas.set(chave, { contagem: 1, primeira: agora, bloqueadoAte: null });
    return;
  }
  reg.contagem += 1;
  if (reg.contagem >= LIMITE) reg.bloqueadoAte = agora + BLOQUEIO_MS;
}

function limparFalhasLogin(req) {
  tentativas.delete(chaveTentativa(req));
}

/* ----------------------------------------------------------------- origem */

/* Confere a origem nas requisições que alteram dados.
 *
 * A sessão vive num cookie, e o navegador o envia sozinho. SameSite=lax já
 * bloqueia POST vindo de outro site, mas depende do navegador respeitá-lo —
 * então conferimos também aqui. O gateway roda em localhost com o navegador da
 * contabilidade aberto em outras abas; uma página qualquer não pode disparar
 * uma emissão de nota fiscal.
 *
 * Chamadas de integração (X-API-Key) não passam por aqui: elas não usam cookie,
 * então não há como um site de terceiros forjá-las.
 */
function conferirOrigem(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

  // Sem cookie de sessão não há o que falsificar
  if (!req.headers.cookie || !req.headers.cookie.includes('nfse_sessao')) return next();

  const origem = req.get('Origin') || req.get('Referer');
  // Alguns clientes locais não mandam Origin; sem ele não há ataque cross-site
  if (!origem) return next();

  let host;
  try { host = new URL(origem).host; } catch (_) { return next(); }

  const permitidos = [req.get('Host')];
  if (process.env.GATEWAY_BASE_URL) {
    try { permitidos.push(new URL(process.env.GATEWAY_BASE_URL).host); } catch (_) { /* ignora */ }
  }

  if (!permitidos.includes(host)) {
    return res.status(403).json({
      erro: 'Requisição recusada: veio de outro endereço. Acesse o painel diretamente.'
    });
  }
  next();
}

/* --------------------------------------------------------------- cabeçalhos */

/* O painel não embute conteúdo de terceiros nem deve ser embutido. */
function cabecalhosSeguranca(_req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  // Tudo é servido pelo próprio gateway: nada externo precisa carregar.
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
    "form-action 'self'; frame-ancestors 'none'; base-uri 'self'");
  next();
}

module.exports = {
  limitarLogin, registrarFalhaLogin, limparFalhasLogin,
  conferirOrigem, cabecalhosSeguranca
};
