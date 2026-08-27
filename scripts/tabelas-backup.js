/* O que entra no backup, e em que ordem volta.
 *
 * Uma lista só, usada pelo backup e pela restauração. Eram duas, e divergiram:
 * identidade, calendário de obrigações e as regras de inscrição municipal eram
 * gravados e nunca restaurados — coisa que só se descobre no dia em que se
 * precisa, que é o pior dia possível.
 *
 * Ordem: quem é referenciado vem antes. Quem é referenciado por ninguém vem no
 * começo, porque é barato.
 */
const TABELAS = [
  // configuração e tabelas de apoio — não dependem de nada
  'municipios',
  'identidade',
  'config_email',
  /* Leva a ligação com o portal e o canal do WhatsApp inteiro: número do
     escritório, App Secret, token de verificação e token do túnel, todos
     cifrados. Sem esta tabela, trocar de máquina significa refazer a
     configuração da Meta do zero. */
  'config_nuvem',
  'atualizacao',
  'backup_destinos',
  'obrigacao_modelos',
  'regra_im_dps',

  // o cadastro
  'empresas',
  'certificados',
  'numeracao_dps',
  'empresa_tokens',
  'usuarios',
  'usuario_empresas',
  'webhooks',
  'tomadores',
  'servicos',
  /* Quem pode pedir nota por WhatsApp, por empresa. É autorização, não
     conveniência: sem isto, restaurar deixa o canal aberto e mudo. */
  'contatos_whatsapp',
  'empresa_obrigacoes',
  'obrigacoes',

  // o histórico
  'notas',
  /* O pedido e a conversa que o gerou. É o que responde "eu não pedi essa
     nota" — o pedido pronto não prova nada, o diálogo prova. */
  'solicitacoes',
  'auditoria'
];

/* As que crescem sem parar. `--sem-notas` as deixa de fora para gerar um
   arquivo de cadastro pequeno, do tamanho de se mandar por e-mail. */
const PESADAS = ['notas', 'solicitacoes', 'auditoria'];

/* Chave natural, quando existe uma melhor que a primária.
 *
 * Restaurar por cima de um banco em uso não pode duplicar a empresa só porque
 * o id mudou. Onde não há chave natural, a restauração pergunta ao próprio
 * Postgres qual é a primária — chutar `(id)` quebrava justamente nas que têm
 * chave composta, como numeracao_dps e regra_im_dps. */
const CHAVE_NATURAL = {
  empresas: '(cnpj)',
  usuarios: '(email)',
  tomadores: '(empresa_id, documento)',
  servicos: '(empresa_id, apelido)'
};

module.exports = { TABELAS, PESADAS, CHAVE_NATURAL };
