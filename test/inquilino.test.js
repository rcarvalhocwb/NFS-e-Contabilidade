const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

/* Isolamento entre ESCRITÓRIOS — a fronteira de fora.
 *
 * isolamento-empresas.test.js cuida da fronteira de dentro: um escritório
 * atende dezenas de CNPJs e não pode misturá-los. Este cuida da de fora:
 * escritórios diferentes, clientes diferentes do mesmo servidor, que não podem
 * nem saber que o outro existe. O que atravessa aqui não é um dado de tela —
 * é certificado A1, senha de e-mail, carteira de clientes.
 *
 * A diferença entre as duas fronteiras é quem garante. A de dentro é o código:
 * a rota confere escopo antes de tocar em dado. A de fora é o banco: policy de
 * RLS em cada tabela, ligada à variável `app.escritorio` da conexão. Essa
 * escolha é deliberada — código esquece um WHERE, e um WHERE esquecido entre
 * escritórios é um incidente que não tem como desfazer.
 *
 * Os testes vêm em dois andares:
 *
 *   ESTRUTURA  roda sempre, sem banco. Confere que nenhuma tabela ficou de
 *              fora por descuido — é o que impede a lista da migração 046 de
 *              envelhecer quando alguém adicionar uma tabela daqui a um ano.
 *
 *   COMPORTAMENTO  roda se houver banco (TEST_DATABASE_URL). Conecta como
 *              papel restrito e tenta mesmo ler o dado do vizinho.
 */

const RAIZ = path.join(__dirname, '..');

function migracoes() {
  const dir = path.join(RAIZ, 'migrations');
  return fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()
    .map(f => ({ nome: f, sql: fs.readFileSync(path.join(dir, f), 'utf8') }));
}

function sqlTodo() {
  return migracoes().map(m => m.sql).join('\n');
}

/* Tabelas que NÃO têm dono, e por quê. Esta lista é o outro lado da lista da
   046: junto, as duas têm de cobrir todas as tabelas do banco. Acrescentar
   tabela sem decidir de que lado ela fica quebra o teste abaixo — que é o
   ponto. A justificativa fica aqui porque é aqui que alguém vai ler quando o
   teste quebrar. */
const SEM_DONO = {
  schema_migrations: 'controle da própria migração',
  municipios:        'código IBGE e modo de emissão são os mesmos para todos',
  regra_im_dps:      'regra municipal de inscrição, idem',
  atualizacao:       'versão do servidor, que é um só',
  config_rede:       'escuta e certificado TLS do servidor: do operador',
  backup_destinos:   'caminhos de disco do servidor: do operador',
  mensagens_vistas:  'wamid da Meta é único no mundo, e a trava vale mais global'
};

function tabelasCriadas() {
  const nomes = new Set();
  /* `schema_migrations` não nasce em migração — nasce no próprio migrate.js,
     antes de existir migração alguma para criá-la. Varrer o script junto
     mantém o inventário completo sem abrir exceção no teste. */
  const fontes = migracoes().map(m => m.sql)
    .concat(fs.readFileSync(path.join(RAIZ, 'scripts', 'migrate.js'), 'utf8'));
  for (const sql of fontes) {
    const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gi;
    let achou;
    while ((achou = re.exec(sql))) nomes.add(achou[1].toLowerCase());
  }
  return nomes;
}

/* A lista de tabelas de inquilino é declarada duas vezes na 046 (uma por
   bloco). Ler do arquivo, em vez de repetir aqui, é o que faz o teste falhar
   quando a migração mudar — uma cópia no teste passaria a concordar consigo
   mesma e com mais ninguém. */
function tabelasComDono() {
  const sql = fs.readFileSync(
    path.join(RAIZ, 'migrations', '046_rls_inquilino.sql'), 'utf8');
  const bloco = sql.match(/tabelas text\[\] := ARRAY\[([\s\S]*?)\]/);
  assert.ok(bloco, 'a 046 precisa declarar a lista de tabelas de inquilino');
  return new Set([...bloco[1].matchAll(/'([a-z_][a-z0-9_]*)'/g)].map(m => m[1]));
}

// ------------------------------------------------------------- ESTRUTURA

test('toda tabela é de um escritório ou está justificada como compartilhada', () => {
  const todas = tabelasCriadas();
  const comDono = tabelasComDono();
  const orfas = [...todas].filter(t =>
    t !== 'escritorios' && !comDono.has(t) && !(t in SEM_DONO)).sort();

  assert.deepStrictEqual(orfas, [],
    'tabela sem lado: ou entra na lista da migração 046 (e ganha escritorio_id\n' +
    '  na 045), ou entra em SEM_DONO aqui com a razão de não ter dono.\n' +
    '  Em dúvida, o lado certo é o do inquilino: sobrar policy não vaza nada.');
});

test('a lista compartilhada não tem tabela que não existe mais', () => {
  const todas = tabelasCriadas();
  const fantasmas = Object.keys(SEM_DONO).filter(t => !todas.has(t));
  assert.deepStrictEqual(fantasmas, [],
    'SEM_DONO cita tabela inexistente — a justificativa sobreviveu à tabela');
});

test('toda tabela de inquilino ganha escritorio_id na 045', () => {
  const sql = fs.readFileSync(
    path.join(RAIZ, 'migrations', '045_escritorios.sql'), 'utf8');
  const bloco = sql.match(/tabelas text\[\] := ARRAY\[([\s\S]*?)\]/);
  assert.ok(bloco, 'a 045 precisa declarar a lista de tabelas que ganham a coluna');
  const naColuna = new Set([...bloco[1].matchAll(/'([a-z_][a-z0-9_]*)'/g)].map(m => m[1]));

  const semColuna = [...tabelasComDono()].filter(t => !naColuna.has(t)).sort();
  assert.deepStrictEqual(semColuna, [],
    'tabela com policy de inquilino mas sem a coluna que a policy compara:\n' +
    '  a policy não protege, ela quebra toda consulta à tabela');
});

test('a policy compara com inquilino_atual(), nunca com valor concatenado', () => {
  const sql = fs.readFileSync(
    path.join(RAIZ, 'migrations', '046_rls_inquilino.sql'), 'utf8');
  assert.match(sql, /USING \(escritorio_id = inquilino_atual\(\)\)/);
  assert.match(sql, /WITH CHECK \(escritorio_id = inquilino_atual\(\)\)/,
    'sem WITH CHECK, um INSERT com escritorio_id alheio é aceito e some da vista');
});

test('inquilino_atual() devolve NULL quando ninguém disse quem é', () => {
  /* A direção do erro é o que importa: `escritorio_id = NULL` não é verdadeiro
     para linha nenhuma. Se a função caísse para um padrão — 1, ou o primeiro
     escritório — esquecer de amarrar a conexão mostraria dados de alguém. */
  const sql = fs.readFileSync(
    path.join(RAIZ, 'migrations', '045_escritorios.sql'), 'utf8');
  const fn = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION inquilino_atual'));
  const corpo = fn.slice(0, fn.indexOf('COMMENT'));
  assert.match(corpo, /current_setting\('app\.escritorio',\s*true\)/,
    "o segundo argumento precisa ser true: sem ele, variável ausente vira erro");
  assert.ok(!/COALESCE/i.test(corpo),
    'COALESCE aqui seria um valor padrão — exatamente o que não pode existir');
});

test('a unicidade global que sobreviveu está justificada no arquivo', () => {
  /* Índice único global entre inquilinos é conflito entre estranhos: um
     escritório recebe erro por causa de linha que não pode ver. Onde isso fica
     de propósito — id da DPS, chave de terminal — a razão tem de estar
     escrita, porque a leitura óbvia é que foi esquecimento. */
  const sql = fs.readFileSync(
    path.join(RAIZ, 'migrations', '045_escritorios.sql'), 'utf8');
  assert.match(sql, /idx_notas_iddps.*FICA GLOBAL/s);
  assert.match(sql, /terminais\.chave.*também fica global/s);
});

test('cnpj de empresa e e-mail de usuário passam a ser únicos por escritório', () => {
  const sql = fs.readFileSync(
    path.join(RAIZ, 'migrations', '045_escritorios.sql'), 'utf8');
  /* Os dois vazavam existência: a segunda casa a cadastrar o mesmo CNPJ ou o
     mesmo contador recebia "já existe" sobre uma linha invisível para ela. */
  assert.match(sql, /CREATE UNIQUE INDEX[^;]*idx_empresas_cnpj[^;]*\(escritorio_id, cnpj\)/s);
  assert.match(sql, /CREATE UNIQUE INDEX[^;]*idx_usuarios_email[^;]*\(escritorio_id, lower\(email\)\)/s);
});

test('a conexão é amarrada antes da consulta, nunca depois', () => {
  /* Conexão de pool é reaproveitada. Depender da limpeza na devolução é
     depender de o caminho de erro ter rodado — e o caminho de erro é
     justamente o que não roda. Amarrar na entrada sobrescreve o que ficou. */
  const db = fs.readFileSync(path.join(RAIZ, 'src', 'db.js'), 'utf8');
  const fn = db.slice(db.indexOf('async function query(text, params)'));
  /* A partir da retirada do pool: antes dela está o atalho de quem já está
     dentro de transação, com a conexão amarrada há mais tempo. */
  const corpo = fn.slice(fn.indexOf('await pool.connect()'), fn.indexOf('\n}\n'));
  const amarra = corpo.indexOf('amarrar(cliente');
  const pergunta = corpo.indexOf('cliente.query(text, params)');
  assert.ok(amarra > 0, 'query precisa amarrar a conexão que retirou do pool');
  assert.ok(pergunta > amarra,
    'amarrar tem de vir antes da consulta: o contrário lê com o inquilino de quem usou antes');
  assert.match(corpo, /finally[\s\S]*cliente\.release\(\)/,
    'a conexão volta ao pool mesmo quando a consulta falha');
});

test('o bloco de inquilino não segura conexão do pool', () => {
  /* Amarrar uma conexão no início da requisição e soltar no fim seria uma ida
     a menos ao banco por consulta. Também seria uma conexão parada durante os
     segundos em que a Sefin demora a responder — e dez emissões simultâneas
     travando o painel de todos os escritórios. */
  const db = fs.readFileSync(path.join(RAIZ, 'src', 'db.js'), 'utf8');
  const fn = db.slice(db.indexOf('async function comInquilino'));
  const corpo = fn.slice(0, fn.indexOf('\n}\n'));
  assert.ok(!/pool\.connect/.test(corpo),
    'comInquilino guarda o número do escritório, não a conexão');
  assert.match(corpo, /contexto\.run\(\s*\{ escritorio: id, cliente: null \}/);
});

test('trocar de inquilino dentro de um bloco é recusado', () => {
  /* O modo silencioso desse erro — a consulta interna rodando com o inquilino
     de fora — não aparece em teste nenhum. Só aparece como dado trocado. */
  const db = fs.readFileSync(path.join(RAIZ, 'src', 'db.js'), 'utf8');
  const fn = db.slice(db.indexOf('async function comInquilino'));
  const corpo = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(corpo, /troca de inquilino dentro de bloco já amarrado/);
});

test('o escritório entra na conexão como parâmetro, não concatenado', () => {
  const db = fs.readFileSync(path.join(RAIZ, 'src', 'db.js'), 'utf8');
  const fn = db.slice(db.indexOf('async function amarrar'));
  const corpo = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(corpo, /set_config\(\$1, \$2, false\)/,
    'SET app.escritorio = ${id} seria injeção com cara de otimização');
});

test('o script do papel recusa dar BYPASSRLS à aplicação', () => {
  /* Papel com BYPASSRLS ignora toda policy: seria desligar o isolamento do
     sistema inteiro e deixar as policies como enfeite. */
  const s = fs.readFileSync(path.join(RAIZ, 'scripts', 'papel-app.js'), 'utf8');
  assert.match(s, /NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS/);
  assert.ok(!/GRANT ALL[^;]*TABLES IN SCHEMA/i.test(s),
    'GRANT em todas as tabelas incluiria as do operador');
});

// --------------------------------------------------------- COMPORTAMENTO

/* O andar de baixo prova a forma do código; este prova o efeito. Sem banco,
   pula — mas pula dizendo, para ninguém confundir "não rodou" com "passou". */
const URL_TESTE = process.env.TEST_DATABASE_URL;
const ADMIN = process.env.TEST_ADMIN_DATABASE_URL || URL_TESTE;

test('um escritório não lê o dado do outro', { skip: !URL_TESTE &&
  'defina TEST_DATABASE_URL (papel restrito) para rodar a prova contra o banco'
}, async () => {
  const { Pool } = require('pg');
  const admin = new Pool({ connectionString: ADMIN });
  const app = new Pool({ connectionString: URL_TESTE });

  const marca = 'teste-' + Date.now();
  let a, b;
  try {
    /* Semeia como administrador: é quem ignora RLS e consegue criar linha nos
       dois escritórios. A aplicação, por definição, não conseguiria. */
    a = (await admin.query(
      `INSERT INTO escritorios (nome) VALUES ($1) RETURNING id`, [marca + '-a'])).rows[0].id;
    b = (await admin.query(
      `INSERT INTO escritorios (nome) VALUES ($1) RETURNING id`, [marca + '-b'])).rows[0].id;
    await admin.query(
      `INSERT INTO empresas (escritorio_id, cnpj, razao_social, codigo_municipio)
       VALUES ($1,$2,$3,$4), ($5,$6,$7,$8)`,
      [a, '11111111000191', marca + ' A', '4106902',
       b, '22222222000192', marca + ' B', '4106902']);

    const cliente = await app.connect();
    try {
      const comoA = async sql => {
        await cliente.query(`SELECT set_config('app.escritorio', $1, false)`, [String(a)]);
        return cliente.query(sql);
      };

      const minhas = await comoA(`SELECT cnpj FROM empresas`);
      assert.deepStrictEqual(minhas.rows.map(r => r.cnpj), ['11111111000191'],
        'o escritório A deve ver a empresa dele e só ela');

      /* WHERE que aponta direto para o vizinho: é o caso em que um WHERE
         esquecido em produção viraria vazamento. A policy responde vazio. */
      const alheia = await comoA(
        `SELECT cnpj FROM empresas WHERE cnpj = '22222222000192'`);
      assert.strictEqual(alheia.rowCount, 0,
        'pedir o CNPJ do vizinho pelo nome ainda assim não pode trazer nada');

      const escritorios = await comoA(`SELECT id FROM escritorios`);
      assert.deepStrictEqual(escritorios.rows.map(r => r.id), [a],
        'nem a lista de escritórios pode revelar que existe outro');

      /* Sem inquilino definido: o modo de falhar precisa ser "nada", não
         "tudo". É a linha entre um bug e um incidente. */
      await cliente.query(`SELECT set_config('app.escritorio', '', false)`);
      const semDono = await cliente.query(`SELECT count(*)::int AS n FROM empresas`);
      assert.strictEqual(semDono.rows[0].n, 0,
        'conexão sem escritório não pode enxergar empresa nenhuma');

      /* WITH CHECK: gravar no vizinho tem de ser recusado, não aceito e
         escondido. Linha gravada e invisível é pior que erro. */
      await cliente.query(`SELECT set_config('app.escritorio', $1, false)`, [String(a)]);
      await assert.rejects(
        cliente.query(
          `INSERT INTO empresas (escritorio_id, cnpj, razao_social, codigo_municipio)
           VALUES ($1, '33333333000193', 'invasora', '4106902')`, [b]),
        /row-level security/i,
        'inserir no escritório do vizinho precisa ser recusado pelo banco');
    } finally {
      cliente.release();
    }
  } finally {
    /* Na ordem das dependências: a FK para `escritorios` é RESTRICT de
       propósito — apagar um escritório com nota emitida é o tipo de coisa que
       o banco deve recusar, e o teste não é exceção a isso. */
    if (a) {
      await admin.query('DELETE FROM empresas WHERE escritorio_id = ANY($1)', [[a, b]]);
      await admin.query('DELETE FROM escritorios WHERE id = ANY($1)', [[a, b]]);
    }
    await admin.end();
    await app.end();
  }
});

test('o papel da aplicação não é dono nem superusuário', { skip: !URL_TESTE &&
  'defina TEST_DATABASE_URL para conferir o papel'
}, async () => {
  /* Se este teste falha, todos os de cima passam e nenhum vale: dono e
     superusuário ignoram policy, então o isolamento provado acima some. */
  const { Pool } = require('pg');
  const app = new Pool({ connectionString: URL_TESTE });
  try {
    const r = await app.query(`
      SELECT current_user AS papel,
             (SELECT rolsuper     FROM pg_roles WHERE rolname = current_user) AS super,
             (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass,
             pg_catalog.pg_get_userbyid(c.relowner) = current_user AS dono
        FROM pg_class c WHERE c.relname = 'empresas'`);
    const { papel, super: sup, bypass, dono } = r.rows[0];
    assert.strictEqual(sup, false, `${papel} é superusuário: ignora toda policy`);
    assert.strictEqual(bypass, false, `${papel} tem BYPASSRLS: ignora toda policy`);
    assert.strictEqual(dono, false, `${papel} é dono das tabelas: ignora policy sem FORCE`);
  } finally {
    await app.end();
  }
});

// -------------------------------------------- a amarração na requisição

test('o inquilino é resolvido antes do auth, não depois', () => {
  /* `auth` lê sessoes, empresa_tokens e usuarios — as três sob policy. Se ele
     rodasse antes da amarração, não acharia sessão nenhuma e todo mundo seria
     anônimo. O sistema não vazaria; pararia. */
  const s = fs.readFileSync(path.join(RAIZ, 'src', 'server.js'), 'utf8');
  const pInquilino = s.indexOf('app.use(inquilino)');
  const pAuth = s.indexOf('app.use(auth)');
  assert.ok(pInquilino > 0, 'o middleware de inquilino precisa estar montado');
  assert.ok(pAuth > pInquilino,
    'app.use(auth) tem de vir depois de app.use(inquilino)');
});

test('o escritório sai da credencial, nunca de um cabeçalho', () => {
  /* Um X-Escritorio seria conveniente e seria o fim do isolamento: escolher
     o próprio inquilino é escolher os dados que se quer ler. */
  const s = fs.readFileSync(path.join(RAIZ, 'src', 'middleware', 'inquilino.js'), 'utf8');
  assert.match(s, /escritorio_da_sessao/);
  assert.match(s, /escritorio_do_token/);
  assert.ok(!/header\(['"]X-Escritorio/i.test(s),
    'o escritório não pode vir de cabeçalho: seria parâmetro de entrada');
  assert.match(s, /hashToken\(/,
    'o que vai ao banco é o hash da credencial, não ela');
});

test('o login confere a senha antes de revelar os escritórios', () => {
  /* Perguntar "em qual escritório?" antes da senha diria, a quem só chutou um
     e-mail, em que casas aquela pessoa trabalha. Depois da senha, é
     informação dela. */
  const s = fs.readFileSync(path.join(RAIZ, 'src', 'routes', 'auth.js'), 'utf8');
  const confere = s.indexOf('conferirSenha');
  const revela = s.indexOf('escritorios: nomes');
  assert.ok(confere > 0 && revela > confere,
    'a lista de escritórios só pode sair depois da conferência de senha');
  assert.match(s, /escritorios_do_email/,
    'os candidatos vêm da função que devolve só ids');
});

test('as funções que atravessam RLS têm search_path fixo', () => {
  /* SECURITY DEFINER com search_path da sessão deixa quem chama plantar uma
     tabela `sessoes` própria e fazer a função lê-la como dona. */
  const sql = fs.readFileSync(
    path.join(RAIZ, 'migrations', '047_inquilino_por_credencial.sql'), 'utf8');
  const definidoras = sql.match(/SECURITY DEFINER[^$]*/g) || [];
  assert.ok(definidoras.length >= 3, 'esperava as três funções de credencial');
  definidoras.forEach(d => assert.match(d, /SET search_path = public/));
});

test('criar escritório é ato de operador, não de inquilino', () => {
  /* Com a URL da aplicação não daria nem para tentar: o papel restrito não
     enxerga outro escritório. O script exige a de administrador. */
  const s = fs.readFileSync(path.join(RAIZ, 'scripts', 'criar-escritorio.js'), 'utf8');
  assert.match(s, /ADMIN_DATABASE_URL/);
  assert.match(s, /senhaSorteada/,
    'a senha do primeiro admin é sorteada, não escolhida por quem cria');
});

// ------------------------------------------------------- os que não têm dono

/* Worker é o ponto cego da RLS.
 *
 * Numa requisição, esquecer de amarrar o inquilino dá erro visível: a tela
 * abre vazia e alguém reclama no mesmo dia. Num worker, o efeito é que a fila
 * simplesmente não anda — nada quebra, nada sai, e ninguém repara até o
 * cliente perguntar da nota que ele emitiu ontem.
 *
 * Por isso o teste é sobre a lista, e não sobre cada worker: todo processo
 * periódico que toca dado de cliente passa por `db.porInquilino`, ou está
 * nomeado abaixo com a razão de não precisar. */
const WORKERS_SEM_INQUILINO = {
  'registro.js':         'apaga arquivo de log velho do disco; não toca no banco',
  'backupAutomatico.js': 'copia o banco inteiro e lê backup_destinos, que é do servidor',
  'atualizacao.js':      'verifica a versão do gateway em atualizacao, que é do servidor'
};

test('todo worker periódico roda por escritório, ou explica por que não', () => {
  const dir = path.join(RAIZ, 'src', 'services');
  /* `setInterval` e não `setTimeout`: o segundo aparece em tudo que tem
     tempo limite de rede ou espera entre tentativas, e varrer por ele
     acusaria meia dúzia de arquivos que não têm laço nenhum. Quem agenda
     rodada periódica aqui usa setInterval. */
  const comTimer = fs.readdirSync(dir).filter(f => f.endsWith('.js') &&
    /setInterval\(/.test(fs.readFileSync(path.join(dir, f), 'utf8')));

  const faltando = comTimer.filter(f =>
    !(f in WORKERS_SEM_INQUILINO) &&
    !/db\.porInquilino/.test(fs.readFileSync(path.join(dir, f), 'utf8'))).sort();

  assert.deepStrictEqual(faltando, [],
    'worker que varre o banco sem db.porInquilino não enxerga linha nenhuma\n' +
    '  sob RLS — e para em silêncio. Ou usa porInquilino, ou entra em\n' +
    '  WORKERS_SEM_INQUILINO aqui com a razão de não tocar em dado de cliente.');
});

test('a justificativa não sobrevive ao worker', () => {
  const dir = path.join(RAIZ, 'src', 'services');
  const sumidos = Object.keys(WORKERS_SEM_INQUILINO)
    .filter(f => !fs.existsSync(path.join(dir, f)));
  assert.deepStrictEqual(sumidos, []);
});

test('o laço do worker não para no erro de um escritório', () => {
  /* Fila parada por causa do vizinho é a falha que multiplica: um escritório
     com problema deixaria todos os outros sem emitir. */
  const db = fs.readFileSync(path.join(RAIZ, 'src', 'db.js'), 'utf8');
  const fn = db.slice(db.indexOf('async function porInquilino'));
  const corpo = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(corpo, /for \(const id of ids\)[\s\S]*try \{[\s\S]*catch/,
    'cada escritório precisa do próprio try: um erro não pode abortar o laço');
  assert.ok(!/Promise\.all/.test(corpo),
    'em sequência, não em paralelo: a fila existe para não sobrecarregar destino externo');
});

// ------------------------------------ o que só apareceu rodando o sistema

/* Estes dois não vieram de leitura de código: vieram de abrir o painel.
   Um mostrava a marca de um escritório a quem não tinha feito login; o outro
   trocava a tela de acesso pelo formulário de primeiro acesso, e ninguém
   entrava. Os dois tinham a mesma causa. */

test('nenhuma consulta usa o pool sem amarrar o inquilino', () => {
  /* Havia um atalho: sem contexto, ia direto no `pool.query`. Parecia
     inofensivo — consulta sem inquilino não deveria ver nada. Mas a conexão
     que o pool entrega já foi de alguém e ainda carrega o `app.escritorio`
     dele, então a consulta "sem inquilino" lia com o inquilino do vizinho.

     Apareceu em `/marca`, que é pública: a tela de acesso mostrava o nome e a
     cor do último escritório que tinha usado aquela conexão. */
  const db = fs.readFileSync(path.join(RAIZ, 'src', 'db.js'), 'utf8');
  const fn = db.slice(db.indexOf('async function query(text, params)'));
  const corpo = fn.slice(0, fn.indexOf('\n}\n'));
  assert.ok(!/return pool\.query/.test(corpo),
    'pool.query entrega conexão com o app.escritorio de quem a usou antes');
  assert.match(corpo, /amarrar\(cliente, ctx \? ctx\.escritorio : null\)/,
    'sem contexto o inquilino é vazio — e vazio também se amarra');
});

test('a marca pública não chuta de quem é a tela', () => {
  /* Antes do login, num servidor de vários escritórios, não há como saber.
     Qualquer escolha mostra o nome e a cor de um cliente a quem nem fez
     login. Melhor tela sem marca que tela com a marca do vizinho. */
  const s = fs.readFileSync(path.join(RAIZ, 'src', 'server.js'), 'utf8');
  const fn = s.slice(s.indexOf('async function marcaPublica'));
  const corpo = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(corpo, /if \(config\.multiEscritorio\) return null/);
  assert.match(corpo, /rows\.length !== 1\) return null/,
    'zero ou mais de um escritório: também não chuta');
  assert.match(corpo, /req\.escritorioId/, 'com sessão, usa o inquilino já amarrado');
});

test('o painel rebusca a marca depois de entrar', () => {
  /* Sem isto o painel fica com a identidade genérica a sessão inteira: a
     única busca acontecia na abertura da página, antes de haver sessão. */
  const s = fs.readFileSync(path.join(RAIZ, 'src', 'public', 'painel.js'), 'utf8');
  const fn = s.slice(s.indexOf('function abrirPainel'));
  assert.match(fn.slice(0, 1400), /carregarMarca\(\)/);
});

test('"a instalação é nova?" não é perguntada sem inquilino', () => {
  /* `usuarios` está sob policy. Perguntado sem inquilino, o sistema se
     declarava recém-instalado: a tela de acesso sumia e dava lugar ao
     formulário de primeiro acesso, num servidor cheio de escritórios.
     Ninguém entrava pelo painel. */
  const s = fs.readFileSync(path.join(RAIZ, 'src', 'routes', 'auth.js'), 'utf8');
  const fn = s.slice(s.indexOf('async function instalacaoTemDono'));
  const corpo = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(corpo, /escritorios_ativos/);
  assert.match(corpo, /ids\.length > 1\) return true/,
    'com vários escritórios a instalação tem dono, por definição');
  assert.match(corpo, /db\.comInquilino\(ids\[0\]/,
    'com um só, a pergunta vale — mas de dentro dele');

  /* A mesma pergunta é a trava da rota de primeiro acesso. Com a versão
     antiga, num servidor de vários ela ficava aberta para sempre. */
  assert.match(s, /if \(await instalacaoTemDono\(\)\) \{/);
});

test('o painel não oferece o que o servidor vai recusar', () => {
  /* Endereço e certificado TLS, destinos de backup, migração, reiniciar:
     com MULTI_ESCRITORIO o servidor responde 403 a quem entra pelo navegador.
     Deixar o botão na tela é a mesma falha que o `data-admin` já resolvia
     para o operador — esbarrar num 403 sem entender o motivo. */
  const html = fs.readFileSync(path.join(RAIZ, 'src', 'public', 'admin.html'), 'utf8');
  assert.ok((html.match(/data-operador/g) || []).length >= 4,
    'as telas do servidor precisam estar marcadas');

  const js = fs.readFileSync(path.join(RAIZ, 'src', 'public', 'painel.js'), 'utf8');
  const fn = js.slice(js.indexOf('function abrirPainel'));
  const corpo = fn.slice(0, fn.indexOf('\n  }\n'));
  const admin = corpo.indexOf("$$('[data-admin]')");
  const operador = corpo.indexOf("$$('[data-operador]')");
  assert.ok(admin > 0 && operador > admin,
    '"Rede e conexão" carrega os dois atributos: o laço do operador tem de ' +
    'correr depois, senão o de admin reexibe o que ele escondeu');
});

test('conexão devolvida ao pool não entrega o inquilino anterior', { skip: !URL_TESTE &&
  'defina TEST_DATABASE_URL para rodar a prova contra o banco'
}, async () => {
  /* A prova de comportamento do primeiro teste desta seção. Roda o caminho
     inteiro: amarra a conexão a um escritório, devolve ao pool, e consulta de
     novo sem inquilino nenhum. */
  const admin = new (require('pg').Pool)({ connectionString: ADMIN });
  const marca = 'pool-' + Date.now();
  let id;
  try {
    id = (await admin.query(
      'INSERT INTO escritorios (nome) VALUES ($1) RETURNING id', [marca])).rows[0].id;
    await admin.query(
      `INSERT INTO empresas (escritorio_id, cnpj, razao_social, codigo_municipio)
       VALUES ($1, $2, $3, '4106902')`, [id, '55555555000155', marca]);

    /* Módulo carregado com a URL do papel restrito, e recarregado do zero para
       não herdar o pool de outro teste. */
    const antes = process.env.DATABASE_URL;
    process.env.DATABASE_URL = URL_TESTE;
    delete require.cache[require.resolve('../src/config')];
    delete require.cache[require.resolve('../src/db')];
    const db = require('../src/db');
    try {
      const dentro = await db.comInquilino(id, () =>
        db.query('SELECT razao_social FROM empresas'));
      assert.strictEqual(dentro.rows.length, 1, 'dentro do bloco, vê a própria empresa');

      const fora = await db.query('SELECT razao_social FROM empresas');
      assert.strictEqual(fora.rowCount, 0,
        'depois de devolver a conexão, consulta sem inquilino não pode herdar nada');
    } finally {
      await db.pool.end();
      process.env.DATABASE_URL = antes;
      delete require.cache[require.resolve('../src/config')];
      delete require.cache[require.resolve('../src/db')];
    }
  } finally {
    if (id) {
      await admin.query('DELETE FROM empresas WHERE escritorio_id = $1', [id]);
      await admin.query('DELETE FROM escritorios WHERE id = $1', [id]);
    }
    await admin.end();
  }
});

test('nenhum serviço pega conexão crua do pool — só o src/db.js', () => {
  /* A fronteira de fora é o banco, e o banco só sabe de quem é a conexão
     porque src/db.js amarra `app.escritorio` na retirada do pool. Um serviço
     que chama `pool.connect()` direto pula essa amarração: a conexão vem com o
     inquilino de quem a usou antes, e a RLS responde por ele. Foi assim que
     services/usuarios.js editava a conta de um usuário de outro escritório —
     confirmado em laboratório, corrigido trocando por db.transacao.

     A defesa não é lembrar de amarrar: é não haver segundo jeito de obter
     conexão. Só src/db.js toca no pool; todo o resto passa por query,
     transacao ou getClient, que já amarram. Esta trava falha se a linha
     voltar — e ela volta sem barulho, uma linha só. */
  function jsDe(dir, achados = []) {
    for (const nome of fs.readdirSync(dir)) {
      const p = path.join(dir, nome);
      if (fs.statSync(p).isDirectory()) jsDe(p, achados);
      else if (nome.endsWith('.js')) achados.push(p);
    }
    return achados;
  }

  const infratores = [];
  for (const arq of jsDe(path.join(RAIZ, 'src'))) {
    if (arq.endsWith(path.join('src', 'db.js'))) continue;   // o único autorizado
    const txt = fs.readFileSync(arq, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    /* `pool.connect(` (conexão crua, sem amarração) e `pool.query(` (consulta
       sem contexto de inquilino) — os dois caminhos que furam o isolamento.
       `pool.end()` fica de fora de propósito: fechar o pool no encerramento é
       ciclo de vida, e o server.js faz isso legitimamente no shutdown. */
    if (/\bpool\.(connect|query)\s*\(/.test(txt)) {
      infratores.push(path.relative(RAIZ, arq));
    }
  }
  assert.deepEqual(infratores, [],
    'estes arquivos tocam no pool sem passar por db.js (amarração de inquilino):\n  ' +
    infratores.join('\n  '));
});
