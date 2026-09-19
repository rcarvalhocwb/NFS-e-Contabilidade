const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

/* O que NÃO pode viajar dentro do instalador do cliente.
 *
 * O licenciamento inteiro depende de uma única coisa: a chave privada estar
 * apenas na máquina de quem vende. Ela não está no repositório, e o pacote é
 * montado por lista de INCLUSÃO — duas camadas. Este teste vigia as duas,
 * porque a falha aqui não é gradual: uma chave privada dentro de um .exe
 * distribuído acaba com o licenciamento de todos os clientes de uma vez, e não
 * há como voltar atrás depois que o arquivo saiu.
 */

const RAIZ = path.join(__dirname, '..');
const PREPARAR = fs.readFileSync(
  path.join(RAIZ, 'instalador', 'preparar-pacote.ps1'), 'utf8');

test('o pacote é montado por lista de inclusão, não de exclusão', () => {
  /* A diferença importa: numa lista de exclusão, pasta nova entra sozinha e
     só sai se alguém lembrar. Numa de inclusão, pasta nova fica de fora por
     padrão — que é o lado certo para errar. */
  const m = PREPARAR.match(/\$incluir\s*=\s*@\(([\s\S]*?)\)/);
  assert.ok(m, 'a lista $incluir sumiu do preparar-pacote.ps1');
  const lista = m[1];
  assert.ok(!/'dev'/.test(lista),
    'a pasta dev/ entrou na lista de inclusão do pacote — ela contém o painel ' +
    'de licenças e o caminho da chave privada');
  assert.ok(!/'test'/.test(lista), 'os testes não vão para a máquina do cliente');
  assert.ok(!/'instalador'/.test(lista), 'o instalador não se empacota dentro de si');
});

test('o emissor de licenças não vai no pacote', () => {
  /* Sem a chave privada ele não emite nada. Mesmo assim: não há motivo para o
     cliente receber a ferramenta de venda do fornecedor. */
  assert.match(PREPARAR, /licenca-emitir\.js/,
    'o emissor precisa estar na lista do que é removido do pacote');
  const fora = PREPARAR.match(/foreach\s*\(\$fora in @\(([\s\S]*?)\)\)/);
  assert.ok(fora, 'o bloco de remoção sumiu');
  assert.match(fora[1], /licenca-emitir\.js/);
});

test('as ferramentas do operador do servidor não vão no pacote', () => {
  /* `papel-app.js` cria papel de banco e distribui GRANT; `criar-escritorio.js`
     abre escritório novo. Nenhuma das duas serve a quem USA o gateway: numa
     instalação de mesa existe um escritório só, e ele nasce das migrações. Um
     segundo ali produziria um estado que o resto do produto não espera.

     Mesmo raciocínio do emissor de licenças, e a mesma razão para um teste:
     a exclusão é uma linha numa lista, e linha em lista some sem barulho. */
  const fora = PREPARAR.match(/foreach\s*\(\$fora in @\(([\s\S]*?)\)\)/);
  assert.ok(fora, 'o bloco de remoção sumiu');
  for (const ferramenta of ['papel-app.js', 'criar-escritorio.js']) {
    assert.ok(fora[1].includes(ferramenta),
      `${ferramenta} precisa sair do pacote: é ferramenta de quem opera o servidor`);
  }
});

test('a pasta dev/ existe e é só do desenvolvedor', () => {
  /* Se um dia ela sumir, este teste some junto e a proteção evapora sem
     ninguém notar. Melhor falhar dizendo o que aconteceu. */
  const dev = path.join(RAIZ, 'dev');
  assert.ok(fs.existsSync(dev), 'a pasta dev/ sumiu — confira se o painel de licenças mudou de lugar');
  for (const arquivo of fs.readdirSync(dev)) {
    const txt = fs.readFileSync(path.join(dev, arquivo), 'utf8');
    assert.ok(!/-----BEGIN (?:\w+ )?PRIVATE KEY-----/.test(txt),
      'chave privada dentro de dev/' + arquivo);
  }
});

test('o produto nunca embute a chave privada, só a pública', () => {
  const chave = fs.readFileSync(
    path.join(RAIZ, 'src', 'licenca', 'chave-publica.js'), 'utf8');
  assert.ok(!/PRIVATE KEY/.test(chave), 'chave privada no módulo que vai para o cliente');
  assert.match(chave, /CHAVE_PUBLICA/);
});

/* Sem comentários: a chave privada é assunto explicado em prosa dentro do
   próprio código, e casar vocabulário em comentário acusaria justamente os
   arquivos que EXPLICAM por que não fazem aquilo. */
function codigo(arquivo) {
  return fs.readFileSync(arquivo, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function jsDe(dir, achados = []) {
  for (const nome of fs.readdirSync(dir)) {
    const p = path.join(dir, nome);
    if (fs.statSync(p).isDirectory()) jsDe(p, achados);
    else if (nome.endsWith('.js')) achados.push(p);
  }
  return achados;
}

test('nada no produto assina licença — só confere', () => {
  /* Assinar no cliente é não ter licenciamento nenhum: quem consegue assinar
     emite a própria licença. `formato.js` DEFINE `assinar` porque o emissor e
     o produto compartilham o formato; o que não pode existir é alguém em src/
     CHAMANDO. */
  const chamam = [];
  for (const arq of jsDe(path.join(RAIZ, 'src'))) {
    if (arq.endsWith(path.join('licenca', 'formato.js'))) continue;
    const txt = codigo(arq);
    if (/\bassinar\s*\(|createPrivateKey|generateKeyPairSync|licenca\.key/.test(txt)) {
      chamam.push(path.relative(RAIZ, arq));
    }
  }
  assert.deepEqual(chamam, [],
    'código do produto tocando em assinatura de licença:\n  ' + chamam.join('\n  '));
});

test('o produto importa a verificação, nunca a assinatura', () => {
  const usos = [];
  for (const arq of jsDe(path.join(RAIZ, 'src'))) {
    if (arq.endsWith(path.join('licenca', 'formato.js'))) continue;
    const txt = codigo(arq);
    /* `licenca/formato` de fora da pasta, `./formato` de dentro dela — o
       segundo caso escapava, e era justamente o vizinho mais provável de
       cometer o erro. */
    const imp = txt.match(/require\(['"](?:[^'"]*licenca\/)?\.?\/?formato['"]\)/g) || [];
    if (!imp.length) continue;
    /* Só o que ele desestrutura importa. `verificar` sim; `assinar` não. */
    const linha = txt.slice(Math.max(0, txt.indexOf(imp[0]) - 120), txt.indexOf(imp[0]));
    if (/\bassinar\b|\bgerarParDeChaves\b/.test(linha)) usos.push(path.relative(RAIZ, arq));
  }
  assert.deepEqual(usos, [],
    'arquivo do produto importando assinatura:\n  ' + usos.join('\n  '));
});

test('o ensaio de instalação não vai para a máquina do cliente', () => {
  /* Ele CRIA E APAGA banco de dados. É a ferramenta que prova, aqui, que uma
     instalação nova sai funcionando — útil para quem desenvolve, superfície sem
     benefício nenhum na máquina de uma contabilidade que guarda nota fiscal. */
  assert.match(PREPARAR, /ensaio-instalacao\.js/,
    'a exclusão precisa nomear o ensaio');
  const fora = PREPARAR.split('foreach ($fora in');
  assert.ok(fora.length > 1, 'a lista de exclusão sumiu do preparar-pacote');
  assert.match(fora[1], /ensaio-instalacao\.js/,
    'e ele precisa estar DENTRO da lista de exclusão, não só citado');

  /* E ele realmente derruba banco — é por isso que fica de fora. Se um dia
     deixar de derrubar, esta trava vira exagero e alguém deve revê-la. */
  const ensaio = fs.readFileSync(path.join(RAIZ, 'scripts', 'ensaio-instalacao.js'), 'utf8');
  assert.match(ensaio, /DROP DATABASE/,
    'se o ensaio parou de apagar banco, reveja se ainda precisa ficar de fora');
});

test('a chave pública do produto é uma chave de verdade', () => {
  /* Nula, o gateway se comporta como instalação sem licença: avisa e emite
     normalmente. Isso era certo enquanto o par não existia — e vira defeito
     silencioso no dia em que um instalador sai para vender com ela nula, porque
     nenhuma licença poderia ser verificada e nada acusaria. */
  const chave = fs.readFileSync(path.join(RAIZ, 'src', 'licenca', 'chave-publica.js'), 'utf8');
  assert.match(chave, /BEGIN PUBLIC KEY/,
    'o produto precisa sair com a chave pública embutida');
  assert.ok(!/\|\|\s*null\s*;/.test(chave),
    'a chave não pode mais cair em null: isso desliga a verificação sem avisar');

  /* E ela precisa verificar de verdade, não ser um texto com a forma certa. */
  const { CHAVE_PUBLICA } = require('../src/licenca/chave-publica');
  const { assinar, verificar, gerarParDeChaves } = require('../src/licenca/formato');
  const outro = gerarParDeChaves();
  const forasteira = assinar({
    v: 1, id: 'LIC-FALSA', plano: 'anual', terminais: 1,
    escritorio: { cnpj: '11222333000181', nome: 'Forjada' },
    emitido_em: '2026-09-16', valido_ate: '2027-09-16', carencia_dias: 30,
    recursos: ['whatsapp']
  }, outro.privada);
  const r = verificar(forasteira, CHAVE_PUBLICA);
  assert.equal(r.valida, false,
    'licença assinada por OUTRA chave não pode passar');
});
