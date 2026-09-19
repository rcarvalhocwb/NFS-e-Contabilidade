const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

/* A pasta de dados graváveis não pode cair em Arquivos de Programas no Windows
   (só-leitura sem administrador → EPERM em log, backup e atualização). */
function fresh() {
  delete require.cache[require.resolve('../src/util/dados')];
  return require('../src/util/dados');
}
const limpar = () => { for (const k of ['LOG_PASTA','BACKUP_PASTA','ATUALIZACAO_PASTA']) delete process.env[k]; };

test('override por variável de ambiente vence', () => {
  limpar();
  process.env.BACKUP_PASTA = '/mnt/pendrive/bkp';
  assert.strictEqual(fresh().pastaBackups(), '/mnt/pendrive/bkp');
  limpar();
});

test('no Windows, o padrão vai para ProgramData, não Arquivos de Programas', () => {
  limpar();
  const platAntes = Object.getOwnPropertyDescriptor(process, 'platform');
  const pdAntes = process.env.PROGRAMDATA;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  process.env.PROGRAMDATA = 'C:\\ProgramData';
  try {
    const d = fresh();
    assert.ok(d.pastaLogs().startsWith('C:\\ProgramData'), d.pastaLogs());
    assert.ok(d.pastaBackups().includes('NFSe Gateway'), d.pastaBackups());
    assert.ok(!/Program Files/i.test(d.pastaLogs()), 'nunca em Arquivos de Programas');
  } finally {
    Object.defineProperty(process, 'platform', platAntes);
    if (pdAntes === undefined) delete process.env.PROGRAMDATA; else process.env.PROGRAMDATA = pdAntes;
    limpar();
  }
});

test('fora do Windows, fica na raiz do projeto', () => {
  limpar();
  const d = fresh();
  assert.ok(d.pastaBackups().endsWith(path.join('nfs-e-contabilidade', 'backups')) ||
            d.pastaBackups().endsWith(path.sep + 'backups'), d.pastaBackups());
});
