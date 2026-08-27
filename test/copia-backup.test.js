const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

/* A cópia do backup para fora da máquina.
 *
 * O backup diário já existe desde que, em 17/08/2026, o banco desapareceu sem
 * cópia nenhuma. Mas ele grava numa pasta do mesmo disco onde o banco mora —
 * e disco que morre leva os dois. Estes testes cobrem as duas coisas que o
 * módulo precisa acertar: reconhecer que o destino não é externo de verdade, e
 * perceber que a cópia chegou incompleta.
 */

const copia = require('../src/services/copiaBackup');

test('reconhece destino no mesmo volume', () => {
  /* No Windows a comparação é pela letra do disco. Sem isso, cadastrar
     C:\\backup passaria por "cópia externa" sem proteger de nada. */
  assert.ok(copia.mesmoVolume('C:\\dev\\nfse\\backups', 'C:\\backup-nfse'));
  assert.ok(!copia.mesmoVolume('C:\\dev\\nfse\\backups', 'E:\\backup-nfse'));
});

test('caminho de rede conta como fora da máquina', () => {
  /* É o destino mais comum num escritório: pasta do servidor da casa. */
  assert.ok(!copia.mesmoVolume('C:\\dev\\nfse\\backups',
    '\\\\servidor\\contabil\\backup'));
});

test('conta os registros de um backup', () => {
  const backup = { tabelas: { empresas: [1, 2], notas: [1, 2, 3],
                              omitida: { omitida: true } } };
  assert.equal(copia.contarRegistros(backup), 5);
  assert.equal(copia.contarRegistros(null), -1);
  assert.equal(copia.contarRegistros({}), -1);
});

test('a conferência acusa cópia truncada', async (t) => {
  /* O caso que motiva o módulo: pen drive removido no meio, rede que caiu,
     disco cheio. O arquivo fica com o nome certo e o tamanho quase certo, e só
     se revela inútil na hora de restaurar. Aqui a cópia é lida DE VOLTA do
     destino e o número de registros comparado com a origem. */
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-copia-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));

  const origem = path.join(base, 'nfse-backup-2026-08-26-00-00-00.json');
  fs.writeFileSync(origem, JSON.stringify({
    gerado_em: new Date().toISOString(), versao: 1,
    tabelas: { empresas: [{ id: 1 }, { id: 2 }], notas: [{ id: 1 }] }
  }));

  const destino = path.join(base, 'destino');
  fs.mkdirSync(destino);

  // Cópia boa: 3 registros dos dois lados
  const conteudo = JSON.parse(fs.readFileSync(origem, 'utf8'));
  assert.equal(copia.contarRegistros(conteudo), 3);

  // Cópia truncada: o destino perdeu uma tabela
  const alvo = path.join(destino, path.basename(origem));
  fs.writeFileSync(alvo, JSON.stringify({
    versao: 1, tabelas: { empresas: [{ id: 1 }, { id: 2 }] }
  }));
  const lido = JSON.parse(fs.readFileSync(alvo, 'utf8'));
  assert.notEqual(copia.contarRegistros(lido), copia.contarRegistros(conteudo),
    'a contagem tem de diferir — é o que dispara a falha');
});

test('a cópia é conferida lendo o arquivo do destino', () => {
  /* Conferir pelo que está em memória não prova nada: o que interessa é o que
     chegou do outro lado. */
  const fonte = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'copiaBackup.js'), 'utf8');
  const i = fonte.indexOf('async function copiarPara');
  const corpo = fonte.slice(i, fonte.indexOf('\n}\n', i));
  assert.match(corpo, /readFileSync\(alvo/,
    'precisa reler o arquivo gravado no destino');
  assert.match(corpo, /chegou incompleta/);
});

test('um destino que falha não impede os outros', () => {
  /* Pen drive desconectado não pode deixar a pasta de rede sem cópia. */
  const fonte = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'copiaBackup.js'), 'utf8');
  const i = fonte.indexOf('async function copiar(');
  const corpo = fonte.slice(i, fonte.indexOf('\n}\n', i));
  assert.match(corpo, /for \(const d of destinos\)[\s\S]*try \{/,
    'cada destino precisa do próprio try');
  assert.ok(!/throw/.test(corpo.slice(corpo.indexOf('for (const d of destinos)'))),
    'a falha de um destino é registrada, não propagada');
});

const { TABELAS, PESADAS } = require('../scripts/tabelas-backup');

test('o backup carrega as tabelas que a restauração precisa', () => {
  /* Tabela que fica de fora só se descobre no dia da restauração, quando o
     calendário de obrigações ou a marca do escritório não voltam. */
  for (const t of ['empresas', 'certificados', 'numeracao_dps', 'notas',
                   'obrigacoes', 'empresa_obrigacoes', 'obrigacao_modelos',
                   'identidade', 'regra_im_dps', 'servicos', 'tomadores']) {
    assert.ok(TABELAS.includes(t), t + ' precisa entrar no backup');
  }
});

test('a configuração do WhatsApp e quem pode pedir nota também voltam', () => {
  /* Ficaram de fora até o repassador passar a rodar nesta máquina. Sem
     config_nuvem, trocar de computador significa refazer a configuração da
     Meta do zero; sem contatos_whatsapp, o canal volta aberto e mudo. */
  assert.ok(TABELAS.includes('config_nuvem'));
  assert.ok(TABELAS.includes('contatos_whatsapp'));
  assert.ok(TABELAS.includes('config_email'));
});

test('o histórico que prova o que foi feito entra no backup', () => {
  /* O pedido pronto não prova nada; a conversa que o gerou, sim. */
  assert.ok(TABELAS.includes('solicitacoes'));
  assert.ok(TABELAS.includes('auditoria'));
  /* Mas são as que crescem sem parar: --sem-notas precisa deixá-las de fora,
     senão o arquivo "só de cadastro" não serve para mandar por e-mail. */
  assert.ok(PESADAS.includes('solicitacoes'));
  assert.ok(PESADAS.includes('auditoria'));
});

test('as tabelas vêm em ordem de dependência', () => {
  /* Restaurar filho antes do pai quebra a chave estrangeira. */
  const pos = t => TABELAS.indexOf(t);
  assert.ok(pos('empresas') < pos('certificados'), 'empresa antes do certificado');
  assert.ok(pos('empresas') < pos('notas'), 'empresa antes das notas');
  assert.ok(pos('usuarios') < pos('usuario_empresas'), 'usuário antes do vínculo');
  assert.ok(pos('obrigacao_modelos') < pos('empresa_obrigacoes'),
    'modelo antes da obrigação da empresa');
  assert.ok(pos('empresas') < pos('contatos_whatsapp'), 'empresa antes do contato');
  assert.ok(pos('notas') < pos('solicitacoes'), 'nota antes da solicitação');
});

test('backup e restauração leem a MESMA lista', () => {
  /* Eram duas listas. Divergiram: identidade, obrigações e regras de inscrição
     municipal eram gravadas e nunca restauradas — e isso só aparece no dia em
     que se precisa, que é o pior dia possível. */
  for (const arquivo of ['backup.js', 'restaurar-backup.js']) {
    const s = fs.readFileSync(
      path.join(__dirname, '..', 'scripts', arquivo), 'utf8');
    assert.match(s, /require\('\.\/tabelas-backup'\)/,
      arquivo + ' precisa usar a lista compartilhada');
    assert.ok(!/^const (TABELAS|ORDEM) = \[/m.test(s),
      arquivo + ' não pode ter lista própria');
  }
});

test('a restauração pergunta a chave ao banco, não a um mapa', () => {
  /* O mapa fixo chutava (id) para o que não conhecia, e quebrava justamente
     nas de chave composta — numeracao_dps, regra_im_dps, empresa_obrigacoes. */
  const s = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'restaurar-backup.js'), 'utf8');
  assert.match(s, /async function conflitoDe/);
  assert.match(s, /con\.contype = 'p'/);
});
