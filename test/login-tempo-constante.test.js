const test = require('node:test');
const assert = require('node:assert');
const usuarios = require('../src/services/usuarios');

/* Enumeração de contas por tempo de resposta.
 *
 * O login roda scrypt (~caro, de propósito) para conferir a senha de uma conta
 * que existe. Para e-mail que não existe, não havia o que conferir e a resposta
 * saía na hora — a diferença de tempo dizia, a quem só chutou um e-mail, se
 * aquela conta existe no sistema. Medido em 76x antes da correção.
 *
 * A defesa é gastar um scrypt mesmo quando não há conta. Estes testes provam
 * que o scrypt fictício custa o mesmo que um real, sem tocar no banco. O fluxo
 * do login (routes/auth.js) chama gastarTempoDeSenha quando nenhuma conta real
 * foi conferida; a prova de que ELE chama roda em inquilino/matriz com banco. */

test('gastarTempoDeSenha existe e nunca confere nada', async () => {
  assert.equal(typeof usuarios.gastarTempoDeSenha, 'function');
  // Não devolve segredo nem "true": só queima tempo. Não estoura com nada.
  assert.equal(await usuarios.gastarTempoDeSenha('qualquer coisa'), undefined);
  assert.equal(await usuarios.gastarTempoDeSenha(''), undefined);
  assert.equal(await usuarios.gastarTempoDeSenha(undefined), undefined);
});

test('o scrypt fictício custa o mesmo que conferir uma senha real', async () => {
  const hashReal = await usuarios.gerarHash('senha-de-verdade-123');

  const amostra = async (fn) => {
    // descarta a primeira (JIT/aquecimento), mede a mediana de algumas
    await fn();
    const tempos = [];
    for (let i = 0; i < 5; i++) {
      const t = process.hrtime.bigint();
      await fn();
      tempos.push(Number(process.hrtime.bigint() - t) / 1e6);
    }
    tempos.sort((a, b) => a - b);
    return tempos[2]; // mediana de 5
  };

  const real = await amostra(() => usuarios.conferirSenha('errada', hashReal));
  const ficticio = await amostra(() => usuarios.gastarTempoDeSenha('errada'));

  /* Mesmos parâmetros de scrypt, então os tempos têm de ficar próximos. Margem
     generosa (3x) porque a máquina de teste divide CPU — o que o oráculo real
     media era 76x, não 2x. Se um dia o hash fictício sair com parâmetros
     diferentes, esta razão dispara e o teste acusa. */
  const razao = Math.max(real, ficticio) / Math.max(0.01, Math.min(real, ficticio));
  assert.ok(razao < 3,
    `scrypt real (${real.toFixed(2)}ms) e fictício (${ficticio.toFixed(2)}ms) ` +
    `divergem ${razao.toFixed(1)}x — o fictício precisa custar o mesmo`);
});
