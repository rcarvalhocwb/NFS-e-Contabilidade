const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

/* O backup é o caminho que a RLS não alcança.
 *
 * Toda a proteção entre escritórios está em policy de banco: consulta que não
 * diz de quem é não traz nada. O backup não é consulta — é um arquivo em
 * disco, servido por um fluxo de leitura. Nenhuma policy vê passar.
 *
 * E o arquivo carrega tudo: o certificado A1 cifrado, os tokens de
 * integração, a carteira inteira de clientes. O nome dele é previsível (data
 * e id). Sem conferir de quem é, bastava pedir o do vizinho.
 *
 * O outro lado do mesmo problema, e o que de fato aconteceu primeiro: sob RLS
 * o backup global passou a sair VAZIO. Ele rodava, imprimia "5 registros",
 * gravava o arquivo, copiava para o pendrive e mostrava verde na tela — com
 * zero empresas, zero certificados e zero notas dentro. Reproduzido contra
 * banco de verdade antes da correção.
 */

const RAIZ = path.join(__dirname, '..');
const fonte = (...p) => fs.readFileSync(path.join(RAIZ, ...p), 'utf8');

test('backup sem dizer de quem é recusa rodar, em vez de sair vazio', () => {
  /* O padrão antigo era "o banco inteiro", o que estava certo quando o banco
     era de um escritório só. Manter o padrão depois da RLS produziria um
     arquivo vazio dizendo que deu certo — e um backup que mente é pior que
     nenhum: nenhum a gente sabe que não tem. */
  const s = fonte('scripts', 'backup.js');
  assert.match(s, /--escritorio N ou --todos/,
    'sem argumento, o script precisa dizer o que falta e parar');
  assert.match(s, /process\.exit\(2\)/);
  assert.match(s, /db\.comInquilino\(Number\(pedido\)/,
    '--escritorio roda amarrado àquele escritório');
  assert.match(s, /db\.porInquilino/, '--todos roda um por escritório');
});

test('o escritório entra no nome do arquivo, não só no conteúdo', () => {
  /* É o que permite recusar o download do arquivo alheio sem abrir e
     inspecionar o conteúdo — e recusar também o DELETE. */
  const s = fonte('scripts', 'backup.js');
  assert.match(s, /-e\$\{escritorioId\}-\$\{carimbo\}\.json/);
  assert.match(s, /escritorio_id: escritorioId/,
    'e no conteúdo também, para a restauração saber onde pôr');
});

test('a rota de download recusa o arquivo do vizinho', () => {
  const s = fonte('src', 'routes', 'manutencao.js');
  const baixar = s.slice(s.indexOf("router.get('/arquivo/:nome'"));
  const corpo = baixar.slice(0, baixar.indexOf('\n});'));
  assert.match(corpo, /arquivoDoEscritorio\(nome, req\.escritorioId\)/,
    'sem esta conferência, o nome previsível do arquivo entrega a casa inteira');
  assert.match(corpo, /404/, 'e responde 404, não 403: não confirma que existe');

  const apagar = s.slice(s.indexOf("router.delete('/arquivo/:nome'"));
  assert.match(apagar.slice(0, apagar.indexOf('\n});')),
    /arquivoDoEscritorio\(nome, req\.escritorioId\)/,
    'apagar o backup do vizinho é tão grave quanto baixá-lo');
});

test('a listagem de backups mostra só os do escritório', () => {
  const s = fonte('src', 'routes', 'manutencao.js');
  assert.match(s, /meusBackups\(req\.escritorioId\)/);
  assert.ok(!/listarArquivos\(\/\^nfse-backup-\.\*/.test(s),
    'nenhuma listagem pode varrer todos os backups da pasta');
});

test('a cópia diária cobre todos os escritórios', () => {
  const s = fonte('src', 'services', 'backupAutomatico.js');
  assert.match(s, /\[script, '--todos'\]/,
    'sem --todos o script recusa rodar e a diária para de existir');
  /* A ordenação por nome deixou de servir: o escritório entra ANTES do
     carimbo de tempo, então nfse-backup-e5-ontem ordena depois de
     nfse-backup-e1-hoje, e a diária acharia que já rodou. */
  assert.match(s, /mtimeMs/);
  assert.ok(!/arquivos\.sort\(\)\.reverse\(\)\[0\]/.test(s));
});

// ------------------------------------------- servidor não é de um escritório

test('as telas do servidor exigem o operador, não o admin do escritório', () => {
  /* config_rede é o certificado TLS da máquina inteira; backup_destinos são
     caminhos de disco; reiniciar derruba o painel de todas as casas. Com
     vários inquilinos, deixar isso com o administrador de um é deixar um
     cliente mexer na infraestrutura dos outros. */
  const s = fonte('src', 'routes', 'manutencao.js');
  const exigemOperador = [
    "'/rede/config'", "'/rede/certificado'", "'/copias'",
    "'/copias/copiar'", "'/copias/:id'", "'/sistema/reiniciar'", "'/migracao'"
  ];
  for (const rota of exigemOperador) {
    const linhas = s.split('\n').filter(l => l.includes(rota) && l.includes('router.'));
    assert.ok(linhas.length, `rota ${rota} sumiu — o teste precisa acompanhar`);
    linhas.forEach(l => assert.match(l, /somenteOperador/,
      `${rota} afeta o servidor inteiro e precisa de somenteOperador`));
  }
});

test('numa instalação de mesa o administrador continua sendo o operador', () => {
  /* Tirar essas telas do administrador quando há um escritório só quebraria o
     produto que roda hoje sem proteger ninguém: lá ele É o operador. */
  const s = fonte('src', 'middleware', 'escopo.js');
  const fn = s.slice(s.indexOf('function somenteOperador'));
  const corpo = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(corpo, /if \(!config\.multiEscritorio\) return somenteAdmin/);
  assert.match(corpo, /tipo === 'maquina'/,
    'a credencial de máquina passa sempre: quem a tem está no servidor');
});

test('o modo é explícito, e o servidor avisa se ficou esquecido', () => {
  /* Deduzir o modo da quantidade de escritórios faria a autorização mudar
     sozinha quando alguém cadastrasse uma linha. O preço de ser explícito é
     poder ficar esquecido — daí o aviso. */
  const s = fonte('src', 'config.js');
  assert.match(s, /multiEscritorio: process\.env\.MULTI_ESCRITORIO === 'true'/);

  const srv = fonte('src', 'server.js');
  const fn = srv.slice(srv.indexOf('async function conferirModoDeOperacao'));
  const corpo = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(corpo, /escritorios_ativos/);
  assert.match(corpo, /console\.warn/);
  assert.match(corpo, /> 1/, 'só avisa quando há mais de um escritório');
});

// ------------------------------------------------------------ restauração

/* Um backup que não restaura não é backup. A metade de volta do caminho tem
   os mesmos problemas de inquilino, e mais um só dela: os ids são globais. */

test('a restauração escreve dentro do escritório, não solta no banco', () => {
  const s = fonte('scripts', 'restaurar-backup.js');
  assert.match(s, /db\.comInquilino\(escritorio, \(\) => gravar\(backup, escritorio\)\)/,
    'sem amarrar, a policy de INSERT recusa e a restauração morre na primeira tabela');
});

test('arquivo antigo, sem escritório, exige que alguém diga qual é', () => {
  /* Backup da versão 1 é de antes da separação. Adivinhar de quem é seria
     despejar a carteira de uma casa dentro de outra, sem desfazer. */
  const s = fonte('scripts', 'restaurar-backup.js');
  assert.match(s, /Este backup não diz de qual escritório é/);
  assert.match(s, /--escritorio N/);
});

test('restaurar a casa de um dentro da casa de outro é recusado', () => {
  /* Não é variação de restauração, é clonar: `empresas.id`, `notas.id` e
     `usuarios.id` são globais, e a carteira da casa 4 traz empresa id 1, que
     já existe. Caber na casa 8 exigiria renumerar tudo e reescrever cada
     chave estrangeira das vinte tabelas que apontam para elas. Meio-feito,
     grava nota apontando para a empresa errada. */
  const s = fonte('scripts', 'restaurar-backup.js');
  const i = s.indexOf('Number(escolhido) !== backup.escritorio_id');
  assert.ok(i > 0, 'a comparação entre o escritório do arquivo e o pedido precisa existir');
  const bloco = s.slice(i, i + 900);
  assert.match(bloco, /process\.exit\(2\)/, 'é recusa, não aviso');
  assert.match(bloco, /outro servidor/, 'e diz o que fazer para mover de servidor');
});

test('as chaves naturais acompanham a unicidade por escritório', () => {
  /* ON CONFLICT precisa bater EXATAMENTE com um índice único. CNPJ e e-mail
     deixaram de ser únicos no banco inteiro na 045 — a lista ficou para trás
     e a restauração morria com "no unique or exclusion constraint matching
     the ON CONFLICT specification". */
  const { CHAVE_NATURAL } = require('../scripts/tabelas-backup');
  assert.strictEqual(CHAVE_NATURAL.empresas, '(escritorio_id, cnpj)');
  assert.strictEqual(CHAVE_NATURAL.usuarios, '(escritorio_id, lower(email))');
});

test('o backup leva a própria linha do escritório, e ela vem primeiro', () => {
  /* Sem ela no arquivo, recuperar de perda total exigia recriar o escritório
     à mão antes de restaurar, sabendo de cabeça o id e o nome. Descobrir isso
     no dia do desastre é descobrir tarde. Primeiro na ordem porque é para
     onde todas as chaves estrangeiras apontam. */
  const { TABELAS } = require('../scripts/tabelas-backup');
  assert.strictEqual(TABELAS[0], 'escritorios');
});

test('o papel restrito pode ajustar sequence, senão o próximo cadastro colide', () => {
  /* A restauração reinsere linhas com id explícito e depois empurra a
     sequência para depois do maior id. Sem UPDATE na sequence ela avisa e
     segue — deixando a sequência atrás dos dados, e a próxima empresa
     cadastrada colide com uma que já existe. */
  const s = fonte('scripts', 'papel-app.js');
  assert.match(s, /GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES/);
  assert.match(s, /ALTER DEFAULT PRIVILEGES[\s\S]{0,200}ON SEQUENCES/,
    'e as sequências que migrações futuras criarem também');
});
