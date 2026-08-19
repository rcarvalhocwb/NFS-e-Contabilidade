const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

/* O corpo precisa chegar ao servidor.
 *
 * Sem o cabeçalho content-type, express.json() ignora o corpo e a rota recebe
 * {}. A requisição responde 200, a tela mostra "salvo", e o que foi gravado é
 * vazio. Foi assim que os padrões fiscais de uma empresa sumiram: a tela tinha
 * os valores, o PUT levava os valores, o banco ficou nulo.
 *
 * O caso oposto é igualmente real: em upload de arquivo (FormData) o navegador
 * precisa gerar o content-type com o boundary. Forçar application/json ali
 * quebra o envio do certificado A1 e da planilha de lote. Daí a distinção por
 * tipo do corpo, e daí este teste cobrir os dois lados. */

function carregarApi(arquivo) {
  const fonte = fs.readFileSync(path.join(__dirname, '..', 'src', 'public', arquivo), 'utf8');
  const inicio = fonte.indexOf('function api(');
  assert.ok(inicio > 0, 'api() não encontrada em ' + arquivo);
  const resto = fonte.slice(inicio);
  const corpo = resto.slice(0, resto.indexOf('\n  }\n') + 4);

  const enviado = [];
  const fetchFalso = (caminho, opcoes) => {
    enviado.push({ caminho, opcoes });
    return Promise.resolve({
      ok: true, status: 200, text: () => Promise.resolve('{}')
    });
  };
  const fabrica = new Function('fetch', 'mostrarTelaAcesso', 'mensagemErro',
    corpo + '; return api;');
  return { api: fabrica(fetchFalso, () => {}, () => 'erro'), enviado };
}

function cabecalho(opcoes, nome) {
  const chave = Object.keys(opcoes.headers || {})
    .find(h => h.toLowerCase() === nome.toLowerCase());
  return chave ? opcoes.headers[chave] : undefined;
}

test('corpo em JSON sai com content-type', async () => {
  const t = carregarApi('painel.js');
  await t.api('/empresas/123/padroes-fiscais',
    { method: 'PUT', body: JSON.stringify({ codigoTributacao: '110201' }) });
  assert.match(cabecalho(t.enviado[0].opcoes, 'content-type'), /application\/json/);
});

test('upload de arquivo não recebe content-type', async () => {
  // FormData: quem monta o cabeçalho, com boundary, é o navegador
  const t = carregarApi('painel.js');
  const arquivo = new FormData();
  arquivo.append('certificado', 'conteudo');
  await t.api('/empresas/123/certificado', { method: 'POST', body: arquivo });
  assert.equal(cabecalho(t.enviado[0].opcoes, 'content-type'), undefined);
});

test('cabeçalho escolhido pelo chamador prevalece', async () => {
  const t = carregarApi('painel.js');
  await t.api('/x', { method: 'POST', body: '<xml/>',
                      headers: { 'Content-Type': 'application/xml' } });
  assert.equal(cabecalho(t.enviado[0].opcoes, 'content-type'), 'application/xml');
});

test('GET sem corpo não ganha content-type', async () => {
  const t = carregarApi('painel.js');
  await t.api('/empresas');
  assert.equal(cabecalho(t.enviado[0].opcoes, 'content-type'), undefined);
});

test('o chamador não tem seus headers alterados', async () => {
  // api() copia antes de acrescentar; mutar o objeto do chamador faria a
  // segunda chamada herdar o cabeçalho da primeira
  const t = carregarApi('painel.js');
  const meus = {};
  await t.api('/x', { method: 'PUT', body: '{}', headers: meus });
  assert.deepEqual(meus, {});
});
