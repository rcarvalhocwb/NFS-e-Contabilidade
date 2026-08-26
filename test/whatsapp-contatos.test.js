const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const w = require('../src/services/contatosWhatsapp');

/* O WhatsApp do cliente ligado à empresa dele.
 *
 * O gateway não fala com o WhatsApp — a API da Meta entrega mensagem por
 * webhook, fazendo POST num endereço público em HTTPS. Isso é a conexão de
 * entrada que a arquitetura evita. Quem recebe é o lado de nuvem que já existe
 * para o portal; aqui só se resolve qual número fala por qual CNPJ.
 */

/* ------------------------------------------------------------- normalização */

test('o nono dígito é reposto', () => {
  /* Celular no Brasil ganhou um nono dígito e a Meta nem sempre entrega com
     ele. 554199998888 e 5541999998888 são a mesma pessoa; comparar texto com
     texto erraria metade das vezes. */
  assert.equal(w.normalizar('554199998888'), '5541999998888');
  assert.equal(w.normalizar('5541999998888'), '5541999998888');
  assert.equal(w.normalizar('(41) 99999-8888'), '5541999998888');
  assert.equal(w.normalizar('41999998888'), '5541999998888');
});

test('fixo não ganha nono dígito', () => {
  /* 3333-4444 começa com 3: é fixo. Repor o 9 criaria um número que não existe. */
  assert.equal(w.normalizar('(41) 3333-4444'), '554133334444');
});

test('número com + já traz o país', () => {
  /* Sem esta distinção, +1 415 555 2671 (11 dígitos) viraria 5514155552671 —
     um brasileiro que não existe. */
  assert.equal(w.normalizar('+1 415 555 2671'), '14155552671');
  assert.equal(w.normalizar('+55 41 99999-8888'), '5541999998888');
});

test('lixo não vira número', () => {
  assert.equal(w.normalizar('abc'), null);
  assert.equal(w.normalizar(''), null);
  assert.equal(w.normalizar(null), null);
  assert.ok(!w.ehValido('123'));
  assert.ok(!w.ehValido('abc'));
});

test('a busca considera as duas formas', () => {
  /* Cadastro antigo pode ter sido gravado sem o nono dígito. */
  const formas = w.variacoes('(41) 99999-8888');
  assert.ok(formas.includes('5541999998888'));
  assert.ok(formas.includes('554199998888'));
});

/* ----------------------------------------------------------------- o teto */

test('o teto por número segura o que passa dele', () => {
  const contato = { limite_valor: 1000 };
  assert.ok(!w.acimaDoTeto(contato, 999.99));
  assert.ok(!w.acimaDoTeto(contato, 1000));
  assert.ok(w.acimaDoTeto(contato, 1000.01));
  assert.ok(!w.acimaDoTeto({ limite_valor: null }, 999999), 'sem teto, nada segura');
});

/* -------------------------------------------------------- regras de escopo */

test('um número fala por uma empresa só', () => {
  /* No WhatsApp não existe barra mostrando qual empresa está selecionada — que
     é justamente o que resolve a confusão no painel. Deixar um número pedir por
     dois CNPJs traria o problema de volta pelo canal onde ele é pior. */
  const fonte = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'contatosWhatsapp.js'), 'utf8');
  const i = fonte.indexOf('async function acrescentar');
  const corpo = fonte.slice(i, fonte.indexOf('\n}\n', i));
  assert.match(corpo, /já pede notas por/);
  assert.match(corpo, /status: 409/);
});

test('o número precisa estar autorizado para a empresa do pedido', () => {
  /* O número identifica; quem decide o escopo é o cadastro. Sem esta
     conferência, bastaria mandar outro CNPJ no payload. */
  const ponte = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'ponteNuvem.js'), 'utf8');
  const i = ponte.indexOf("origem === 'whatsapp'");
  assert.ok(i > 0, 'a ponte precisa tratar a origem whatsapp');
  const corpo = ponte.slice(i, ponte.indexOf('\n    }', i));
  assert.match(corpo, /whatsapp\.resolver\(remetente\)/);
  assert.match(corpo, /não está autorizado a pedir notas/);
  assert.match(corpo, /Number\(contato\.empresa_id\) !== Number\(e\.id\)/,
    'e o CNPJ do pedido tem de bater com o do cadastro');
});

test('acima do teto não recusa, só chama gente', () => {
  const ponte = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'ponteNuvem.js'), 'utf8');
  const i = ponte.indexOf('acimaDoTeto');
  const corpo = ponte.slice(i, i + 500);
  assert.match(corpo, /confira antes de aprovar/);
  assert.ok(!/situacao = 'recusada'/.test(corpo),
    'o teto é para dar corda curta, não para barrar');
});

test('a origem é uma lista fechada', () => {
  const sql = fs.readFileSync(
    path.join(__dirname, '..', 'migrations', '028_contato_whatsapp.sql'), 'utf8');
  assert.match(sql, /CHECK \(origem IN \('portal', 'whatsapp', 'api'\)\)/);
  const ponte = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'ponteNuvem.js'), 'utf8');
  assert.match(ponte, /ORIGENS\.includes\(s\.origem\) \? s\.origem : 'portal'/,
    'origem desconhecida vira portal, não passa direto para o banco');
});

test('o gateway continua sem receber conexão de fora', () => {
  /* O webhook da Meta exige endereço público em HTTPS. Se um dia aparecer uma
     rota aqui para recebê-lo, este teste cai — e é para cair: seria expor à
     internet a máquina com os certificados A1 de todos os clientes. */
  const raiz = path.join(__dirname, '..', 'src', 'routes');
  for (const arquivo of fs.readdirSync(raiz).filter(f => f.endsWith('.js'))) {
    const s = fs.readFileSync(path.join(raiz, arquivo), 'utf8');
    assert.ok(!/router\.(post|get)\([^)]*webhook.*whatsapp/i.test(s),
      arquivo + ': nenhuma rota de webhook do WhatsApp no gateway');
    assert.ok(!/hub\.challenge/.test(s),
      arquivo + ': o desafio de verificação da Meta não pertence a esta máquina');
  }
});

test('remover contato respeita a empresa da URL', () => {
  /* O id vem da URL; a empresa vem do CNPJ conferido pelo middleware. Sem o par,
     trocar o id apagaria o contato de outro cliente da casa. */
  const rotas = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'routes', 'empresas.js'), 'utf8');
  const i = rotas.indexOf("'/:cnpj/whatsapp/:id'");
  assert.ok(i > 0);
  const corpo = rotas.slice(i, rotas.indexOf('\n});', i));
  assert.match(corpo, /WHERE id = \$1 AND empresa_id = \$2/);
});
