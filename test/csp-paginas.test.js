const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

/* As páginas contra a Content-Security-Policy do próprio gateway.
 *
 * A política é `script-src 'self'`: o navegador só executa script vindo de
 * arquivo do próprio servidor. Script escrito dentro do HTML, atributo
 * `onclick=` e `href="javascript:"` são recusados em silêncio — do ponto de
 * vista de quem usa, a tela simplesmente não faz nada.
 *
 * Foi o que aconteceu com a emissão por conversa: todo o código dela morava num
 * <script> dentro do emitir.html, e a página abria com o cabeçalho, o campo de
 * texto e mais nada. Nenhum erro na tela; só uma linha no console que ninguém
 * tinha motivo para abrir.
 */

const PUBLICO = path.join(__dirname, '..', 'src', 'public');
const paginas = fs.readdirSync(PUBLICO).filter(f => f.endsWith('.html'));

test('existem páginas para conferir', () => {
  assert.ok(paginas.length >= 3, 'esperava admin, nota e emitir');
});

test('a política continua sendo script-src self', () => {
  /* Se um dia alguém afrouxar para 'unsafe-inline', os testes abaixo perdem o
     sentido — então o valor é conferido aqui, e não presumido. */
  const servidor = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  assert.match(servidor, /script-src 'self'/);
  assert.ok(!/script-src[^;]*unsafe-inline/.test(servidor),
    'inline liberado tornaria estes testes inúteis');
});

for (const pagina of paginas) {
  const html = fs.readFileSync(path.join(PUBLICO, pagina), 'utf8');

  test(pagina + ': nenhum <script> escrito na página', () => {
    /* Um <script> sem src é código inline. A CSP recusa, e a página vira uma
       casca sem comportamento. */
    const tags = html.match(/<script(\s[^>]*)?>/gi) || [];
    for (const tag of tags) {
      assert.match(tag, /\ssrc\s*=/i,
        pagina + ' tem script inline — a CSP vai recusá-lo: ' + tag);
    }
  });

  test(pagina + ': nenhum manipulador inline', () => {
    const inline = html.match(/\son(click|change|submit|input|load|focus|blur)\s*=/gi) || [];
    assert.deepEqual(inline, [],
      pagina + ' usa atributo de evento no HTML, que a CSP também recusa');
    assert.ok(!/href\s*=\s*["']javascript:/i.test(html),
      pagina + ' usa href="javascript:", recusado pela CSP');
  });

  test(pagina + ': o script que carrega existe em disco', () => {
    /* Caminho errado no src falha do mesmo jeito silencioso: 404 no console e
       tela morta. */
    const srcs = [...html.matchAll(/<script[^>]*\ssrc\s*=\s*["']([^"']+)["']/gi)]
      .map(m => m[1]);
    assert.ok(srcs.length, pagina + ' não carrega script nenhum');
    for (const src of srcs) {
      assert.match(src, /^\/assets\//, 'o script vem de /assets: ' + src);
      const arquivo = path.join(PUBLICO, src.replace('/assets/', ''));
      assert.ok(fs.existsSync(arquivo), 'arquivo ausente: ' + arquivo);
    }
  });
}

test('emitir.html carrega o emitir.js', () => {
  /* O caso concreto que motivou o arquivo. */
  const html = fs.readFileSync(path.join(PUBLICO, 'emitir.html'), 'utf8');
  assert.match(html, /<script src="\/assets\/emitir\.js"><\/script>/);

  const js = fs.readFileSync(path.join(PUBLICO, 'emitir.js'), 'utf8');
  assert.match(js, /function iniciar/, 'o código da conversa precisa estar lá');
  assert.match(js, /\/emissor\/contexto/, 'e continuar buscando o contexto');
});
