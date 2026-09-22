const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

/* Migração que edita município que nunca foi inserido.
 *
 * Três migrações (029, 037, 038) faziam `UPDATE municipios ... WHERE
 * codigo_municipio = '4107652'` e nenhuma inseria a linha. Em banco que já
 * rodava, ela tinha vindo de cadastro manual e os UPDATEs pegavam. Em banco
 * novo — máquina nova, restauração, servidor de teste — os três rodavam sem
 * erro nenhum e afetavam zero linhas.
 *
 * É o pior formato de bug de migração: não falha, não avisa, e o que some é
 * justamente o dado que faz a mensagem de erro ser útil. Quem emitisse para
 * lá receberia "município não classificado" em vez de "vá ao portal do Betha
 * e credencie-se antes".
 *
 * O teste lê as migrações, não o banco: precisa pegar o problema antes de
 * alguém instalar numa máquina nova.
 */

const DIR = path.join(__dirname, '..', 'migrations');

function migracoes() {
  return fs.readdirSync(DIR).filter(f => f.endsWith('.sql')).sort()
    .map(f => ({ nome: f, sql: fs.readFileSync(path.join(DIR, f), 'utf8') }));
}

test('todo município editado por migração é inserido por alguma migração', () => {
  const editados = new Map();   // código -> primeira migração que edita
  const inseridos = new Set();

  for (const m of migracoes()) {
    /* UPDATE em municipios apontando um código específico. O `[\s\S]*?` cobre
       o SET multilinha entre o UPDATE e o WHERE. */
    const re = /UPDATE\s+municipios\b[\s\S]*?WHERE\s+codigo_municipio\s*=\s*'(\d+)'/gi;
    let achou;
    while ((achou = re.exec(m.sql))) {
      if (!editados.has(achou[1])) editados.set(achou[1], m.nome);
    }

    /* INSERT que cite o código em qualquer posição da lista de VALUES.
       Aproximado de propósito: um casamento mais estrito daria falso alarme a
       cada formatação nova, e o que importa aqui é existir o INSERT. */
    const reIns = /INSERT\s+INTO\s+municipios\b[\s\S]*?VALUES\s*\(([\s\S]*?)\)\s*(?:ON\s+CONFLICT|;)/gi;
    let ins;
    while ((ins = reIns.exec(m.sql))) {
      for (const c of ins[1].matchAll(/'(\d{7})'/g)) inseridos.add(c[1]);
    }
  }

  const orfaos = [...editados.entries()]
    .filter(([codigo]) => !inseridos.has(codigo))
    .map(([codigo, onde]) => `${codigo} (editado em ${onde})`);

  assert.deepStrictEqual(orfaos, [],
    'município editado por UPDATE sem nenhum INSERT que o crie:\n' +
    '  em banco novo o UPDATE afeta zero linhas, sem erro, e o dado some.\n' +
    '  Use INSERT ... ON CONFLICT (codigo_municipio) DO UPDATE, como faz a\n' +
    '  037 para São José dos Pinhais.');
});

test('a semente de Fazenda Rio Grande não apaga a confirmação de quem testou', () => {
  /* `emissor_confirmado` é falso até alguém conferir credenciamento e
     endereço com certificado na mão. Quem confirmou foi uma pessoa; uma
     migração que sobrescrevesse isso faria a emissão voltar a ser recusada
     num banco onde já funcionava. */
  const sql = fs.readFileSync(path.join(DIR, '048_fazenda_rio_grande.sql'), 'utf8');
  const doUpdate = sql.slice(sql.indexOf('DO UPDATE SET'), sql.indexOf(';', sql.indexOf('DO UPDATE SET')));
  assert.ok(!/emissor_confirmado\s*=/.test(doUpdate),
    'emissor_confirmado não pode entrar no DO UPDATE');
  assert.match(sql, /emissor_confirmado/,
    'mas precisa estar no INSERT, para nascer falso em banco novo');
});
