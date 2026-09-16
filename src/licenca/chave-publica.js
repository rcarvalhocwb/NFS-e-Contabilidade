/* A chave PÚBLICA que confere as licenças. Vai dentro do produto, em toda
 * instalação — não é segredo e não precisa ser: com ela dá para verificar uma
 * licença, nunca para emitir uma.
 *
 * A privada mora em %USERPROFILE%\.nfse\licenca.key na máquina de quem vende,
 * fora do repositório. O repositório é privado, mas o instalador é montado a
 * partir dele: chave aqui dentro é chave que um dia viaja num .exe.
 *
 * Para trocar: `node scripts/licenca-emitir.js --gerar-chaves` imprime a nova
 * pública. TROCAR INVALIDA TODAS AS LICENÇAS JÁ EMITIDAS — é operação de
 * comprometimento de chave, não de manutenção.
 *
 * Gerado em 16/09/2026, antes do primeiro instalador — de propósito: trocar a
 * chave invalida toda licença já emitida, e o custo disso só cresce. Com zero
 * licenças no mundo, era o momento mais barato que vai existir.
 *
 * A variável de ambiente continua vencendo para o caso de emergência (chave
 * comprometida, cliente com par próprio), mas o padrão agora é a chave de
 * verdade — não mais nulo.
 */
const CHAVE_PUBLICA = process.env.NFSE_LICENCA_CHAVE_PUBLICA ||
  '-----BEGIN PUBLIC KEY-----\n' +
  'MCowBQYDK2VwAyEAuf/wtqBz+84eRRPiZ1EJrzhq+09tJ6WknJCvpSKIPkw=\n' +
  '-----END PUBLIC KEY-----\n';

module.exports = { CHAVE_PUBLICA };
