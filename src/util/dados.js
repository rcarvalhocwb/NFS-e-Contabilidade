const path = require('path');

/* Onde ficam os dados que MUDAM em runtime: logs, cópias de segurança e
 * pacotes de atualização.
 *
 * No Windows a instalação vive em "Arquivos de Programas", que é só-leitura
 * para quem não é administrador — gravar ali estoura com EPERM assim que o
 * gateway roda com a conta normal do escritório (que é como ele deve rodar).
 * ProgramData (C:\ProgramData) é o lugar padrão do Windows para dado de
 * aplicativo comum a todos os usuários da máquina, e é gravável: uma pasta
 * criada ali pelo processo pertence a quem a criou.
 *
 * Fora do Windows, ou sem %PROGRAMDATA%, fica a raiz do projeto — exatamente
 * onde sempre esteve, para não mudar nada em desenvolvimento nem em servidor.
 *
 * As variáveis LOG_PASTA / BACKUP_PASTA / ATUALIZACAO_PASTA continuam vencendo:
 * quem aponta um destino explícito manda, e é assim que se põe o backup num
 * pendrive ou numa pasta de rede.
 */
function baseDados() {
  if (process.platform === 'win32' && process.env.PROGRAMDATA) {
    return path.join(process.env.PROGRAMDATA, 'NFSe Gateway');
  }
  return path.join(__dirname, '..', '..');
}

const resolver = (envVar, nome) =>
  process.env[envVar] || path.join(baseDados(), nome);

module.exports = {
  baseDados,
  pastaLogs: () => resolver('LOG_PASTA', 'logs'),
  pastaBackups: () => resolver('BACKUP_PASTA', 'backups'),
  pastaAtualizacoes: () => resolver('ATUALIZACAO_PASTA', 'atualizacoes'),
  /* Onde o módulo do WhatsApp grava sessão e token. Precisa ser O MESMO caminho
     para dois processos diferentes: o próprio módulo (wa/servidor.js), que
     escreve, e o gateway (whatsappLocal.js), que lê o token para falar com ele.
     Por isso a resolução vive aqui, num lugar só. */
  pastaWhatsapp: () => resolver('NFSE_WA_DADOS', 'wa')
};
