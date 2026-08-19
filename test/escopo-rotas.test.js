const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

/* Toda rota que aceita CNPJ de fora precisa conferir o escopo.
 *
 * As rotas de consulta e cancelamento recebiam o CNPJ da empresa no corpo ou
 * na query e falavam com a Sefin usando o certificado A1 daquela empresa — sem
 * conferir se quem pediu tinha acesso a ela. Num escritório de contabilidade,
 * bastava informar o CNPJ de outro cliente para consultar as notas dele; no
 * cancelamento, para cancelar um documento fiscal autorizado alheio, assinado
 * com o certificado que o gateway guarda.
 *
 * Verificado na prática antes da correção: um operador vinculado só à empresa
 * B recebeu HTTP 200 ao consultar uma NFS-e da empresa A.
 *
 * O escopo das LISTAGENS sempre esteve certo (filtroSqlEmpresas). O furo era
 * nas rotas que confiam num identificador vindo do cliente — e é essa a forma
 * que este teste vigia. */

const FONTE = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'nfse.js'), 'utf8')
  .replace(/\r\n/g, '\n');

/* Formas legítimas de aplicar escopo, cada uma para um tipo de rota:
     filtroSqlEmpresas    — listagens: o filtro entra no WHERE
     exigirEmpresaNoEscopo— rotas que recebem o CNPJ de quem chamou
     notaNoEscopo/acharNota — rotas que devolvem uma nota
     empresaVisivel       — conferência direta */
const PROTECOES = /exigirEmpresaNoEscopo|empresaVisivel|notaNoEscopo|acharNota|filtroSqlEmpresas/;

/* Corpo de cada rota declarada no arquivo, para inspecionar uma por uma. */
function rotas(fonte) {
  const achadas = [];
  const r = /router\.(get|post|put|delete)\(\s*'([^']+)'/g;
  let m;
  while ((m = r.exec(fonte))) {
    const inicio = m.index;
    const proxima = new RegExp('router\\.(get|post|put|delete)\\(', 'g');
    proxima.lastIndex = m.index + m[0].length;
    const seguinte = proxima.exec(fonte);
    achadas.push({
      metodo: m[1].toUpperCase(),
      caminho: m[2],
      corpo: fonte.slice(inicio, seguinte ? seguinte.index : fonte.length)
    });
  }
  return achadas;
}

test('as rotas que recebem cnpjEmpresa conferem o escopo', () => {
  const desprotegidas = rotas(FONTE)
    .filter(rota => /req\.(body|query)[.\[]|b\.cnpjEmpresa/.test(rota.corpo))
    .filter(rota => /cnpjEmpresa/.test(rota.corpo))
    .filter(rota => !PROTECOES.test(rota.corpo))
    .map(rota => `${rota.metodo} ${rota.caminho}`);

  assert.deepEqual(desprotegidas, [],
    'rota aceita CNPJ do cliente e não confere escopo:\n  ' + desprotegidas.join('\n  '));
});

test('as rotas que devolvem uma nota conferem o escopo dela', () => {
  // acharNota() aplica notaNoEscopo; o que não pode é buscar a nota direto
  const suspeitas = rotas(FONTE)
    .filter(rota => /FROM notas|acharNota/.test(rota.corpo))
    .filter(rota => !PROTECOES.test(rota.corpo))
    .map(rota => `${rota.metodo} ${rota.caminho}`);

  assert.deepEqual(suspeitas, [], 'rota lê notas sem filtrar por escopo');
});

test('o detector enxerga uma rota desprotegida', () => {
  // Sem isto, o teste acima ficaria verde para sempre se a varredura quebrasse
  const exemplo = `
    router.post('/:chave/cancelamento', async (req, res, next) => {
      const b = req.body || {};
      if (!b.cnpjEmpresa) return res.status(400).json({ erro: 'obrigatorio' });
      const resultado = await cancelar(b.cnpjEmpresa, req.params.chave, b);
      res.json(resultado);
    });`;
  const achadas = rotas(exemplo)
    .filter(r => /cnpjEmpresa/.test(r.corpo))
    .filter(r => !PROTECOES.test(r.corpo));
  assert.equal(achadas.length, 1, 'a varredura precisa acusar esta rota');
  assert.equal(achadas[0].caminho, '/:chave/cancelamento');
});

test('a conferência responde 404, não 403', () => {
  /* 403 confirmaria que o CNPJ existe no sistema — para um escritório, que
     aquela empresa é cliente da casa. Quem não tem escopo não distingue
     "não existe" de "não é seu". */
  const fn = FONTE.slice(FONTE.indexOf('async function exigirEmpresaNoEscopo'));
  const corpo = fn.slice(0, fn.indexOf('\n}\n') + 3);
  assert.match(corpo, /status\(404\)/);
  assert.ok(!/status\(403\)/.test(corpo), 'não pode revelar a existência da empresa');
});
