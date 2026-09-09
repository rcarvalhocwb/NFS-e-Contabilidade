const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { assinar, verificar, gerarParDeChaves, canonico } = require('../src/licenca/formato');
const { avaliar, RECURSOS_LICENCIADOS } = require('../src/licenca/estado');

/* A licença, e a única regra dela que não se negocia.
 *
 * O gateway roda na máquina do cliente, em JavaScript legível: quem tem a
 * máquina apaga qualquer conferência. A assinatura não existe para impedir
 * isso — existe para que ninguém FABRIQUE uma licença que o gateway aceite.
 * São coisas diferentes, e só a segunda é alcançável.
 *
 * O resto destes testes existe para uma frase: licença nunca impede emitir.
 */

const par = gerarParDeChaves();

function licencaDe(mudanca = {}) {
  return assinar(Object.assign({
    id: 'LIC-2026-0001',
    escritorio: { cnpj: '11222333000181', nome: 'Contabilidade Exemplo' },
    plano: 'anual',
    emitido_em: '2026-01-01',
    valido_ate: '2026-12-31',
    carencia_dias: 30,
    terminais: 3,
    recursos: ['whatsapp', 'portal', 'atualizacoes']
  }, mudanca), par.privada);
}

const em = (iso) => new Date(iso + 'T12:00:00');

/* ------------------------------------------------------------- a assinatura */

test('a licença assinada é aceita', () => {
  const r = verificar(licencaDe(), par.publica);
  assert.equal(r.valida, true, r.motivo);
  assert.equal(r.dados.escritorio.cnpj, '11222333000181');
  assert.equal(r.dados.terminais, 3);
});

test('mudar UM caractere do conteúdo derruba a assinatura', () => {
  /* O ataque óbvio: abrir a licença, esticar o vencimento, salvar. */
  const lic = licencaDe();
  const [corpo, assinatura] = lic.split('.');
  const claro = Buffer.from(corpo.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString();
  const adulterado = claro.replace('2026-12-31', '2099-12-31');
  assert.notEqual(adulterado, claro, 'o teste precisa realmente ter mudado algo');

  const forjada = Buffer.from(adulterado).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') + '.' + assinatura;

  const r = verificar(forjada, par.publica);
  assert.equal(r.valida, false);
  assert.match(r.motivo, /assinatura não confere/);
  /* Os dados voltam mesmo assim, para quem atende o telefone saber o que a
     pessoa tentou usar — mas com valida:false. */
  assert.equal(r.dados.valido_ate, '2099-12-31');
});

test('licença de outra chave não é aceita', () => {
  const outro = gerarParDeChaves();
  const r = verificar(licencaDe(), outro.publica);
  assert.equal(r.valida, false);
});

test('lixo no lugar da licença não derruba nada', () => {
  /* Verificar NUNCA lança: no gateway a decisão é "avisa e segue emitindo", e
     uma exceção aqui viraria um catch genérico lá em cima. */
  for (const ruim of [null, '', 'abc', 'a.b', '...', 'x'.repeat(5000), 42, {}]) {
    const r = verificar(ruim, par.publica);
    assert.equal(r.valida, false, JSON.stringify(ruim));
    assert.ok(typeof r.motivo === 'string' && r.motivo.length > 0);
  }
});

test('a serialização é estável, senão a licença verifica só numa máquina', () => {
  /* JSON.stringify não promete ordem de chave entre versões do Node. Uma
     licença que verifica aqui e falha no cliente é o pior tipo de defeito:
     aparece longe, meses depois. */
  const a = canonico({ b: 1, a: 2, c: { z: 1, y: 2 } });
  const b = canonico({ c: { y: 2, z: 1 }, a: 2, b: 1 });
  assert.equal(a, b);
});

test('a licença cabe numa linha de e-mail', () => {
  assert.ok(licencaDe().length < 700, 'passou de 700 caracteres: ' + licencaDe().length);
  assert.ok(!/\s/.test(licencaDe()), 'não pode ter espaço nem quebra de linha');
});

/* --------------------------------------------------- a regra que não quebra */

test('EMITIR NUNCA É BLOQUEADO, em situação nenhuma', () => {
  const casos = [
    ['em dia',       licencaDe(), em('2026-06-01')],
    ['vencendo',     licencaDe(), em('2026-12-20')],
    ['em carência',  licencaDe(), em('2027-01-15')],
    ['vencida',      licencaDe(), em('2027-06-01')],
    ['sem licença',  null,        em('2026-06-01')],
    ['adulterada',   licencaDe().slice(0, -4) + 'AAAA', em('2026-06-01')]
  ];
  for (const [nome, lic, agora] of casos) {
    const e = avaliar(lic, par.publica, { agora });
    assert.equal(e.podeEmitir, true, 'com licença ' + nome + ' precisa continuar emitindo');
  }
});

test('as situações seguem o calendário', () => {
  const lic = licencaDe();  // vence 2026-12-31, carência 30
  const s = (iso) => avaliar(lic, par.publica, { agora: em(iso) }).situacao;
  assert.equal(s('2026-06-01'), 'ativa');
  assert.equal(s('2026-12-05'), 'vencendo', 'anual avisa com 30 dias');
  assert.equal(s('2026-12-31'), 'vencendo', 'no dia do vencimento ainda não venceu');
  assert.equal(s('2027-01-01'), 'carencia');
  assert.equal(s('2027-01-30'), 'carencia', 'último dia de carência ainda é carência');
  assert.equal(s('2027-01-31'), 'vencida');
});

test('o plano mensal avisa mais perto, senão o aviso vira paisagem', () => {
  const mensal = licencaDe({ plano: 'mensal', valido_ate: '2026-10-04' });
  const s = (iso) => avaliar(mensal, par.publica, { agora: em(iso) }).situacao;
  assert.equal(s('2026-09-20'), 'ativa', 'faltando 14 dias, um mensal ainda está tranquilo');
  assert.equal(s('2026-10-01'), 'vencendo', 'faltando 3 dias, avisa');
});

test('só WhatsApp, portal e atualizações dependem de licença', () => {
  /* Emitir, consultar, cancelar, baixar XML e fazer backup ficam de fora de
     propósito: são obrigação fiscal ou saída de dados. Cliente sem licença
     precisa conseguir levar o que é dele embora. */
  assert.deepEqual(RECURSOS_LICENCIADOS.sort(), ['atualizacoes', 'portal', 'whatsapp']);
  for (const proibido of ['emitir', 'cancelar', 'backup', 'xml', 'relatorios', 'migracao']) {
    assert.ok(!RECURSOS_LICENCIADOS.includes(proibido),
      proibido + ' não pode depender de licença');
  }
});

test('a degradação só chega depois da carência', () => {
  const lic = licencaDe();
  const rec = (iso) => avaliar(lic, par.publica, { agora: em(iso) }).recursos;
  assert.equal(rec('2027-01-15').whatsapp, true, 'em carência, tudo continua');
  assert.equal(rec('2027-01-31').whatsapp, false, 'passada a carência, degrada');
  assert.equal(rec('2027-01-31').atualizacoes, false);
});

test('recurso não contratado fica desligado mesmo com licença em dia', () => {
  const semPortal = licencaDe({ recursos: ['whatsapp'] });
  const r = avaliar(semPortal, par.publica, { agora: em('2026-06-01') }).recursos;
  assert.equal(r.whatsapp, true);
  assert.equal(r.portal, false);
});

test('licença de outro CNPJ avisa e não bloqueia', () => {
  const e = avaliar(licencaDe(), par.publica,
    { agora: em('2026-06-01'), cnpjEscritorio: '99888777000166' });
  assert.match(e.alerta, /outro CNPJ/);
  assert.equal(e.situacao, 'ativa', 'a licença em si continua válida');
  assert.equal(e.podeEmitir, true);
});

test('terminais é limite contratado, não trava', () => {
  const e = avaliar(licencaDe(), par.publica, { agora: em('2026-06-01') });
  assert.equal(e.terminaisContratados, 3);
  /* Não existe campo dizendo "bloquear terminal": passar do contratado é
     assunto de cobrança, e quem estoura continua trabalhando. */
  assert.ok(!('bloquearTerminais' in e));
});

/* ------------------------------------------------ a chave privada não vaza */

test('nenhuma chave privada no repositório', () => {
  /* O repositório é privado, mas o instalador é montado a partir dele: chave
     aqui dentro é chave que um dia viaja dentro de um .exe. */
  const raiz = path.join(__dirname, '..');
  const suspeitos = [];
  const varrer = (dir) => {
    for (const nome of fs.readdirSync(dir)) {
      if (['node_modules', '.git', 'backups', 'logs', 'postgres', 'instalador'].includes(nome)) continue;
      const p = path.join(dir, nome);
      const st = fs.statSync(p);
      if (st.isDirectory()) { varrer(p); continue; }
      if (!/\.(js|json|pem|key|txt|md|sql|ps1|bat)$/i.test(nome)) continue;
      const txt = fs.readFileSync(p, 'utf8');
      if (/-----BEGIN (?:\w+ )?PRIVATE KEY-----/.test(txt)) suspeitos.push(path.relative(raiz, p));
    }
  };
  varrer(path.join(raiz, 'src'));
  varrer(path.join(raiz, 'scripts'));
  assert.deepEqual(suspeitos, [], 'chave privada versionada:\n  ' + suspeitos.join('\n  '));
});
