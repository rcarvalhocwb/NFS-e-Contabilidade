const test = require('node:test');
const assert = require('node:assert');

/* Quando a senha é provisória.
 *
 * A regra: senha definida por OUTRA pessoa é provisória e obriga a troca;
 * senha definida por si mesmo, não.
 *
 * Sem a segunda metade, o administrador que trocasse a própria senha pela tela
 * de Usuários ficava marcado para trocar de novo — e o diálogo de troca
 * obrigatória voltava a cada carga da página. Foi relatado como "a tela de
 * troca de senha aparece toda hora".
 *
 * A decisão mora na rota, que é quem sabe quem está pedindo; o serviço só
 * aplica o que recebe. Estes testes cobrem a decisão. */

/* Reproduz a regra da rota PUT /usuarios/:id. */
function decidirTrocaObrigatoria(corpo, auth, idAlvo) {
  const b = Object.assign({}, corpo);
  if (b.senha && b.trocarSenha === undefined &&
      auth.tipo === 'usuario' && Number(auth.usuarioId) === idAlvo) {
    b.trocarSenha = false;
  }
  return b.trocarSenha;
}

const EU = { tipo: 'usuario', usuarioId: 7 };

test('senha que defino para outra pessoa é provisória', () => {
  // undefined = o serviço marca como provisória, que é o padrão desejado
  assert.equal(decidirTrocaObrigatoria({ senha: 'nova-senha-123' }, EU, 99), undefined);
});

test('senha que defino para mim mesmo não é provisória', () => {
  assert.equal(decidirTrocaObrigatoria({ senha: 'nova-senha-123' }, EU, 7), false);
});

test('escolha explícita do administrador prevalece', () => {
  // Se ele marcou que quer obrigar a troca, obriga — mesmo na própria conta
  assert.equal(decidirTrocaObrigatoria({ senha: 'x1234567', trocarSenha: true }, EU, 7), true);
  assert.equal(decidirTrocaObrigatoria({ senha: 'x1234567', trocarSenha: false }, EU, 99), false);
});

test('edição sem trocar senha não mexe na marcação', () => {
  assert.equal(decidirTrocaObrigatoria({ nome: 'Outro nome' }, EU, 7), undefined);
});

test('credencial de máquina não é "si mesmo"', () => {
  // A chave global não tem conta; senha definida por ela é sempre provisória
  const maquina = { tipo: 'maquina' };
  assert.equal(decidirTrocaObrigatoria({ senha: 'nova-senha-123' }, maquina, 7), undefined);
});

/* O outro caminho: trocar a própria senha pelo diálogo do painel sempre limpa
   a marcação, porque quem digitou a senha nova foi o dono da conta. */
test('trocarPropriaSenha limpa a marcação', () => {
  const { trocarPropriaSenha } = require('../src/services/usuarios');
  const fonte = trocarPropriaSenha.toString();
  assert.match(fonte, /trocar_senha\s*=\s*FALSE/i,
    'a troca pelo próprio usuário precisa limpar trocar_senha');
});
