/* O termo que o escritório aceita antes de ligar o WhatsApp por sessão própria.
 *
 * VERSIONADO de propósito. O aceite guarda a versão do texto, e o texto de cada
 * versão fica aqui para sempre: "o cliente aceitou" só vale como resposta se
 * for possível mostrar O QUE ele aceitou, dois anos depois, quando a conversa
 * for outra.
 *
 * Escrito para ser LIDO. Um termo que ninguém lê não protege ninguém — protege
 * menos ainda quem o escreveu, porque a defesa de "estava no contrato" não
 * sobrevive a um texto desenhado para não ser lido. Frases curtas, sem latim,
 * e o que importa em primeiro lugar.
 */

const VERSAO = '2026-09-1';

const TEXTO = `TERMO DE USO — WHATSAPP POR SESSÃO PRÓPRIA

Leia antes de aceitar. São dois minutos e a decisão é sua.

1. O QUE É ISTO
   Você está ligando o WhatsApp do seu escritório ao sistema por uma sessão
   própria — a mesma que o WhatsApp Web usa. Não é a API oficial do WhatsApp
   Business.

2. NÃO HÁ RELAÇÃO COM O WHATSAPP NEM COM A META
   Quem fornece este sistema não tem contrato, parceria, autorização nem canal
   de suporte com a Meta Platforms, Inc. ou com o WhatsApp LLC. Este recurso usa
   bibliotecas de terceiros, de código aberto, mantidas por pessoas fora desta
   empresa.

3. O NÚMERO PODE SER BANIDO
   O WhatsApp pode bloquear, suspender ou banir o número usado aqui, a qualquer
   momento, sem aviso e sem explicação. Isso é decisão do WhatsApp e não há a
   quem recorrer.

   Se isso acontecer, você perde o número — não só a emissão de notas por ele.
   As conversas dos seus clientes, os documentos recebidos e o histórico vão
   junto.

   POR ISSO: use um número separado, dedicado ao sistema. Nunca o número
   principal do escritório.

4. PODE PARAR DE FUNCIONAR A QUALQUER MOMENTO
   O WhatsApp muda o funcionamento interno dele quando quer. Uma mudança dessas
   pode derrubar este recurso de um dia para o outro, sem que haja o que fazer
   além de esperar uma atualização das bibliotecas de terceiros — que pode vir
   em dias, em meses, ou não vir.

5. QUEM FORNECE O SISTEMA NÃO SE RESPONSABILIZA
   Não nos responsabilizamos por:
     - bloqueio, suspensão ou banimento do número;
     - o recurso ficar indisponível, instável ou parar de funcionar;
     - mensagens não entregues, entregues em duplicidade ou fora de ordem;
     - qualquer prejuízo decorrente dos itens acima.

   Isto é um recurso de conveniência, apoiado em software de terceiros que não
   controlamos.

6. O QUE CONTINUA GARANTIDO
   A emissão de notas fiscais NÃO depende deste recurso. Se o WhatsApp parar,
   por qualquer motivo, você continua emitindo, consultando, cancelando e
   baixando XML e DANFSe normalmente pelo painel. Nenhum pedido em andamento se
   perde: ele fica na fila e pode ser concluído aqui dentro.

7. A ALTERNATIVA OFICIAL CONTINUA DISPONÍVEL
   A API oficial do WhatsApp Business, da Meta, está implementada neste sistema
   e não tem nenhum dos riscos acima. Ela exige conta Meta Business, verificação
   da empresa e um número dedicado que sai do aplicativo. Se o WhatsApp for
   crítico para a sua operação, é o caminho recomendado.

8. SEUS DADOS
   A sessão do WhatsApp fica gravada nesta máquina, na pasta do módulo. Quem
   tiver acesso a esses arquivos consegue usar o número. Trate a pasta como
   trata o certificado digital.

Ao aceitar, você declara que leu, entendeu e escolhe usar assim mesmo.`;

/* As versões anteriores ficam aqui quando houver. Nunca se apaga: um aceite
   registrado com a versão "2026-09-1" precisa poder ser lido em 2030. */
const HISTORICO = {
  '2026-09-1': TEXTO
};

function texto(versao) {
  return HISTORICO[versao || VERSAO] || null;
}

/* Um resumo de três linhas para a tela, antes do texto inteiro. Quem vai
   aceitar precisa saber do que se trata antes de decidir se lê tudo — e quem
   não ler nada precisa ao menos ter visto isto. */
const RESUMO = [
  'Isto usa uma sessão comum do WhatsApp, não a API oficial.',
  'O número pode ser banido pelo WhatsApp, e não há a quem recorrer.',
  'A emissão de notas não depende disso e continua funcionando de qualquer forma.'
];

module.exports = { VERSAO, TEXTO, RESUMO, texto, HISTORICO };
