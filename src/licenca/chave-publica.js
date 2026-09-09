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
 * Enquanto o par definitivo não for gerado, isto fica nulo e o gateway se
 * comporta como instalação sem licença: avisa na tela e emite normalmente.
 */
const CHAVE_PUBLICA = process.env.NFSE_LICENCA_CHAVE_PUBLICA || null;

module.exports = { CHAVE_PUBLICA };
