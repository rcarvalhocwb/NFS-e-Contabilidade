/* Acesso ao banco, com o inquilino amarrado à conexão.
 *
 * O ISOLAMENTO NÃO ESTÁ AQUI — ele está nas policies da migração 046. Este
 * arquivo só responde à pergunta que a policy faz: "de quem é esta conexão?".
 * A resposta vai na variável de sessão `app.escritorio`.
 *
 * O PERIGO DO POOL
 *
 * Conexão de pool é reaproveitada. Se a requisição do escritório 7 define
 * `app.escritorio = 7` e devolve a conexão sem limpar, a próxima requisição a
 * pegar aquela conexão herda o 7 — e passa a ler dados de um escritório que
 * não é o dela. Isso é exatamente o vazamento que a RLS existe para impedir,
 * reintroduzido pela camada de baixo.
 *
 * A defesa não é lembrar de limpar na saída — limpar na saída depende de o
 * caminho de erro ter rodado, e o caminho de erro é justamente o que não
 * roda. A defesa é amarrar na ENTRADA, sempre: toda conexão retirada do pool
 * recebe o valor antes da primeira consulta, sobrescrevendo o que estiver lá.
 * Conexão suja não existe porque nada é lido antes de ser amarrado.
 *
 * FORA DE REQUISIÇÃO
 *
 * Worker de fila não tem inquilino: ele tem todos. `porInquilino` roda a mesma
 * função uma vez por escritório ativo, cada uma na sua conexão amarrada. Custa
 * um laço; evita ter de dar BYPASSRLS ao papel da aplicação, que desligaria o
 * isolamento do sistema inteiro para resolver o problema de um worker.
 */
const { AsyncLocalStorage } = require('async_hooks');
const { Pool } = require('pg');
const config = require('./config');

const pool = new Pool({ connectionString: config.databaseUrl });

/* Guarda o inquilino da requisição/tarefa atual — o número, não a conexão.
   Sem isto, todo `db.query` precisaria receber o escritório como argumento, e
   o dia em que uma chamada esquecesse seria o dia do vazamento. */
const contexto = new AsyncLocalStorage();

/* Conexão sem inquilino ainda serve para o que é do servidor: migração,
   `escritorios_ativos()`, health check. Não serve para ler dado de cliente —
   e a policy garante isso devolvendo zero linha, não um erro. Deixamos passar
   em vez de bloquear aqui porque um bloqueio nesta camada seria um segundo
   lugar para acertar, e dois lugares divergem. */
function atual() {
  return contexto.getStore();
}

async function amarrar(cliente, escritorioId) {
  /* set_config com is_local = false: vale para a sessão, não para uma
     transação. O código chamador é livre para abrir e fechar transações
     dentro do bloco sem perder o inquilino no caminho.

     O valor vai como parâmetro. `SET app.escritorio = ...` não aceita
     parâmetro e exigiria concatenar — e concatenar identificador de inquilino
     é como se escreve um bug de isolamento com cara de otimização. */
  await cliente.query('SELECT set_config($1, $2, false)',
    ['app.escritorio', escritorioId === null || escritorioId === undefined
      ? '' : String(escritorioId)]);
}

/* Roda `fn` com toda consulta amarrada a um escritório.
 *
 * NÃO SEGURA CONEXÃO. A tentação é retirar uma do pool aqui, amarrar e
 * devolver no fim da requisição — uma amarração só, uma ida a menos ao banco
 * por consulta. O preço aparece na emissão: a requisição fica parada segundos
 * esperando a Sefin responder, e a conexão fica parada junto. Dez emissões
 * simultâneas esgotam o pool, e o que trava não é a emissão — é o painel
 * inteiro, para todos os escritórios.
 *
 * Então o que o bloco guarda é o número, não a conexão. Cada consulta retira,
 * amarra, pergunta e devolve. Custa uma ida a mais ao banco; não custa uma
 * conexão parada durante chamada externa.
 *
 * Aninhar é permitido para o mesmo escritório. Aninhar com escritório
 * DIFERENTE é recusado: é sempre erro de programação, e o modo silencioso
 * dele (a consulta interna rodando com o inquilino de fora) é indetectável
 * em teste. */
async function comInquilino(escritorioId, fn) {
  if (escritorioId === null || escritorioId === undefined || escritorioId === '') {
    throw new Error('comInquilino exige um escritório; use comServidor para o que não tem dono');
  }
  const id = Number(escritorioId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`escritório inválido: ${escritorioId}`);
  }

  const dentro = atual();
  if (dentro && dentro.escritorio === id) return fn();
  if (dentro && dentro.escritorio !== null) {
    throw new Error(
      `troca de inquilino dentro de bloco já amarrado (${dentro.escritorio} -> ${id})`);
  }

  return contexto.run({ escritorio: id, cliente: null }, fn);
}

/* Para o que é do servidor e não de um escritório: verificação de saúde,
   leitura de `escritorios_ativos()`, tarefa de manutenção. Amarra
   explicitamente a vazio — não deixa "sem contexto", que cairia no caminho
   do pool nu e poderia herdar o que a conexão trouxesse de antes. */
async function comServidor(fn) {
  return contexto.run({ escritorio: null, cliente: null }, fn);
}

/* Roda `fn(escritorioId)` uma vez por escritório ativo, em sequência.
 *
 * É como um worker de fila trabalha aqui. Ele não tem "requisição atual": ele
 * tem todos os escritórios. A alternativa seria dar BYPASSRLS ao papel da
 * aplicação para ele varrer a fila inteira de uma vez — desligar o isolamento
 * do sistema todo para conveniência de um laço.
 *
 * Sequência e não paralelo: a fila existe para não sobrecarregar destino
 * externo, e disparar N escritórios de uma vez desfaz isso. O erro de um não
 * interrompe os outros — fila parada por causa do vizinho é a falha que
 * multiplica.
 */
async function porInquilino(fn, aoFalhar) {
  const ids = await comServidor(async () => {
    const r = await query('SELECT * FROM escritorios_ativos() AS id');
    return r.rows.map(l => l.id);
  });

  for (const id of ids) {
    try {
      await comInquilino(id, () => fn(id));
    } catch (erro) {
      if (aoFalhar) aoFalhar(erro, id);
      else console.error(`[inquilino ${id}]`, erro.message);
    }
  }
  return ids.length;
}

/* Consulta amarrada ao inquilino do bloco atual.
 *
 * Três caminhos, e a ordem importa:
 *   1. dentro de transação (`transacao`): a conexão já está amarrada e aberta;
 *   2. dentro de bloco de inquilino: retira, amarra, pergunta, devolve;
 *   3. fora de tudo: pool nu, sem inquilino. Sobrou para inicialização e
 *      script. Numa requisição é bug — e o sintoma é consulta vazia, não
 *      dado alheio, porque a policy não encontra inquilino nenhum.
 */
async function query(text, params) {
  const ctx = atual();
  if (ctx && ctx.cliente) return ctx.cliente.query(text, params);
  if (!ctx) return pool.query(text, params);

  const cliente = await pool.connect();
  try {
    await amarrar(cliente, ctx.escritorio);
    return await cliente.query(text, params);
  } finally {
    /* Sem RESET: a próxima retirada amarra de novo antes de perguntar. Confiar
       na limpeza da devolução seria confiar no caminho de erro, que é
       justamente o que não roda. */
    cliente.release();
  }
}

/* Transação com o inquilino amarrado. Tudo que rodar dentro de `fn` — pelo
   cliente recebido ou por `db.query` — vai na mesma conexão e na mesma
   transação. Sem isto, `db.query` dentro de um BEGIN pegaria OUTRA conexão do
   pool e as duas metades da operação ficariam em transações diferentes. */
async function transacao(fn) {
  const ctx = atual();
  if (ctx && ctx.cliente) return fn(ctx.cliente);

  const cliente = await pool.connect();
  try {
    await amarrar(cliente, ctx ? ctx.escritorio : null);
    await cliente.query('BEGIN');
    const saida = await contexto.run(
      { escritorio: ctx ? ctx.escritorio : null, cliente }, () => fn(cliente));
    await cliente.query('COMMIT');
    return saida;
  } catch (erro) {
    try { await cliente.query('ROLLBACK'); } catch (_) { /* conexão já perdida */ }
    throw erro;
  } finally {
    cliente.release();
  }
}

/* Conexão exclusiva, amarrada, para quem controla BEGIN/COMMIT na mão.
   Quem puder, prefira `transacao`: ela fecha a transação no caminho de erro
   também, e faz `db.query` entrar junto. */
async function getClient() {
  const ctx = atual();
  if (ctx && ctx.cliente) {
    /* Fachada: `release` vira no-op para o chamador não devolver ao pool uma
       conexão que a transação de fora ainda usa. */
    return {
      query: (text, params) => ctx.cliente.query(text, params),
      release: () => {}
    };
  }
  const cliente = await pool.connect();
  await amarrar(cliente, ctx ? ctx.escritorio : null);
  return cliente;
}

module.exports = {
  query,
  getClient,
  transacao,
  comInquilino,
  comServidor,
  porInquilino,
  inquilinoAtual: () => (atual() || {}).escritorio ?? null,
  pool
};
