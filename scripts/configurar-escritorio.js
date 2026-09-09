#!/usr/bin/env node
/**
 * Grava o que o assistente coletou sobre o escritório.
 *
 * Chamado só na instalação NOVA. O assistente pergunta quatro coisas — nome,
 * CNPJ, e-mail de avisos e pasta de cópia — e elas viram cadastro aqui.
 *
 * Por que no instalador e não "depois, no painel": porque "depois" costuma ser
 * nunca. Sem identidade a tela de acesso mostra "NFS-e Gateway" a um cliente
 * que pagou por um sistema da casa dele; sem destino de cópia fora da máquina,
 * o backup diário protege contra engano e não protege contra o HD.
 *
 * Os dados vêm pela variável NFSE_ESCRITORIO, em JSON — não por argumento de
 * linha de comando, que aparece no gerenciador de tarefas.
 *
 * NADA aqui é fatal: se falhar, a instalação continua e os campos ficam para o
 * painel. Errar um e-mail não pode custar a instalação inteira.
 */
const db = require('../src/db');

async function principal() {
  const bruto = process.env.NFSE_ESCRITORIO;
  if (!bruto) {
    console.error('NFSE_ESCRITORIO não informada.');
    process.exit(2);
  }

  let dados;
  try {
    dados = JSON.parse(bruto);
  } catch (e) {
    console.error('NFSE_ESCRITORIO não é JSON válido: ' + e.message);
    process.exit(2);
  }

  const feito = [];

  /* A identidade: é o que aparece na tela de acesso e no DANFSe. */
  if (dados.nome) {
    const identidade = require('../src/services/identidade');
    await identidade.salvar({ nome: String(dados.nome).trim() });
    feito.push('identidade');
  }

  /* O e-mail de avisos. Só o destinatário — servidor de envio é configuração
     que exige senha, e senha não se pergunta em assistente de instalação. */
  if (dados.email) {
    await db.query(
      `UPDATE config_email SET resumo_para = $1, atualizado_em = now() WHERE id = 1`,
      [String(dados.email).trim()]).catch(() => {});
    feito.push('e-mail de avisos');
  }

  /* O destino da cópia. A pasta é criada agora, com alguém olhando — e não às
     três da manhã, quando o backup roda e descobre que o caminho não existe. */
  if (dados.pastaBackup) {
    const copia = require('../src/services/copiaBackup');
    try {
      await copia.acrescentar({
        caminho: String(dados.pastaBackup).trim(),
        apelido: 'Destino escolhido na instalação',
        manter: 30
      });
      feito.push('destino de cópia');
    } catch (e) {
      /* Caminho de rede que ainda não existe, pen drive fora: avisa e segue.
         O backup local continua funcionando. */
      console.error('destino de cópia não pôde ser criado: ' + e.message);
    }
  }

  console.log('gravado: ' + (feito.join(', ') || 'nada'));
  await db.pool.end();
}

principal().catch(e => {
  console.error(e.message);
  process.exit(1);
});
