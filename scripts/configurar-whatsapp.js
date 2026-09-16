#!/usr/bin/env node
/**
 * A primeira configuração do WhatsApp, feita pelo instalador.
 *
 * Chamado pelo `instalador/whatsapp.ps1` na instalação nova, quando a pessoa
 * escolheu um dos dois caminhos no assistente.
 *
 * O QUE ELE NÃO FAZ, e é de propósito:
 *
 *   - NÃO aceita o termo do transporte por sessão própria. O termo diz que o
 *     número pode ser banido e que quem fornece o gateway não responde por
 *     isso; um aceite embutido em "Avançar" não seria aceite de ninguém. Quem
 *     lê e marca a caixa é uma pessoa, na tela do módulo, e é assim que o
 *     registro com nome e data vale alguma coisa.
 *
 *   - NÃO liga o transporte local. Ligar depende do aceite acima, e
 *     `whatsappLocal.definirAtivo` recusa sem ele — corretamente. Aqui só se
 *     deixa a porta escolhida e tudo pronto para a pessoa ligar em um clique.
 *
 * O que ele FAZ é tirar do caminho tudo que não precisa de gente: credenciais,
 * portas, transporte e as palavras do robô.
 *
 * Dados por NFSE_WHATSAPP (JSON) — o token da Meta está aí dentro, e linha de
 * comando aparece no gerenciador de tarefas.
 */
const db = require('../src/db');

const feito = [];
const pendencias = [];

async function principal() {
  const bruto = process.env.NFSE_WHATSAPP;
  if (!bruto) {
    console.error('NFSE_WHATSAPP não informada.');
    process.exit(2);
  }

  let d;
  try {
    d = JSON.parse(bruto);
  } catch (e) {
    console.error('NFSE_WHATSAPP não é JSON válido: ' + e.message);
    process.exit(2);
  }

  /* ---------------------------------------------- as palavras do robô */

  /* Primeiro, porque não depende de transporte nenhum: mesmo quem escolheu
     "nenhum por enquanto" ganha o texto certo quando ligar o WhatsApp depois. */
  if (d.saudacao || d.atendente || d.horario) {
    try {
      const chatbot = require('../src/services/chatbot');
      await chatbot.salvar({
        saudacao: d.saudacao || undefined,
        atendente: d.atendente || undefined,
        horario: d.horario || undefined
      });
      feito.push('textos do atendimento gravados');
    } catch (e) {
      pendencias.push({ item: 'textos do atendimento', motivo: e.message });
    }
  }

  const ponte = require('../src/services/ponteNuvem');

  /* --------------------------------------------- plataforma oficial */

  /* As CREDENCIAIS não são pedidas aqui, e é decisão, não esquecimento.
   *
   * Phone Number ID, token de envio, App Secret e verify token nascem no painel
   * da Meta depois de conta aprovada e empresa verificada — semanas, às vezes.
   * Pedir isso num assistente de instalação garante que a maioria das pessoas
   * chegue nessa tela sem ter os valores, e então ou inventa algo para seguir,
   * ou desiste da instalação inteira. O instalador prepara o terreno (túnel,
   * repassador, porta) e o resto se faz no sistema, com calma. */
  if (d.transporte === 'meta') {
    try {
      await ponte.salvar({
        waNumero: d.numero || undefined,
        /* O repassador roda NESTA máquina. A alternativa seria hospedá-lo, e
           hospedar um repassador por escritório é infraestrutura que o
           escritório não comprou. */
        relayLocal: true,
        relayPorta: d.relayPorta || undefined,
        tunelBinario: d.tunelBinario || undefined,
        tunelAtivo: d.tunelBinario ? true : undefined
      });
      await db.query(
        "UPDATE config_nuvem SET wa_transporte = 'meta', atualizado_em = now() WHERE id = TRUE");
      feito.push('repassador e túnel preparados para a plataforma oficial');

      if (!d.tunelBinario) {
        pendencias.push({
          item: 'endereço público',
          motivo: 'o cloudflared não foi instalado, então o webhook da Meta ' +
                  'ainda não tem por onde chegar. O painel, em Portal do ' +
                  'cliente, explica como resolver.'
        });
      }

      pendencias.push({
        item: 'credenciais da Meta',
        motivo: 'informe o Phone Number ID, o token, o App Secret e o token de ' +
                'verificação no painel, em Portal do cliente. Eles nascem no ' +
                'painel da Meta depois de a conta ser aprovada.'
      });
    } catch (e) {
      pendencias.push({ item: 'plataforma oficial', motivo: e.message });
    }
  }

  /* ------------------------------------------------ sessão própria */

  if (d.transporte === 'local') {
    try {
      /* Só a porta. `definirAtivo` recusaria sem o aceite do termo, e recusar
         é o comportamento certo — então nem se tenta. */
      await db.query(
        'UPDATE whatsapp_local SET porta = COALESCE($1, porta), atualizado_em = now() WHERE id = 1',
        [d.porta || null]);
      feito.push('módulo do WhatsApp na porta ' + (d.porta || 'padrão'));

      /* O transporte fica em 'local' desde já: assim o painel abre mostrando o
         caminho que a pessoa escolheu, em vez de oferecer a Meta que ela
         recusou no assistente. Não emite nada — só escolhe por onde sairia. */
      await db.query(
        "UPDATE config_nuvem SET wa_transporte = 'local', atualizado_em = now() WHERE id = TRUE");

      await ponte.salvar({
        waNumero: d.numero || undefined,
        relayLocal: true,
        relayPorta: d.relayPorta || undefined
      });

      pendencias.push({
        item: 'conectar o número',
        motivo: 'abra o ícone "WhatsApp" na área de trabalho, leia o termo e ' +
                'aponte a câmera do celular para o QR code. São dois minutos, ' +
                'e precisa ser feito por alguém com o celular na mão.'
      });
    } catch (e) {
      pendencias.push({ item: 'módulo do WhatsApp', motivo: e.message });
    }
  }

  console.log(JSON.stringify({ feito, pendencias }, null, 2));
  await db.pool.end();
  process.exit(0);
}

principal().catch(e => {
  console.error(e.message);
  process.exit(1);
});
