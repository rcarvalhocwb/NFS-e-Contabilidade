/* Gerador de arquivo ZIP mínimo, sem dependência externa.
   Usa o método "store" (sem compressão): XML comprime bem, mas para um export
   de utilidade a simplicidade e a robustez valem mais que o tamanho, e evita
   depender de detalhes do formato deflate. Produz um ZIP válido lido por
   qualquer descompactador (testado com Expand-Archive do Windows).

   CRC-32 é calculado à mão para funcionar em qualquer versão do Node
   (zlib.crc32 só existe a partir do 20.15; o projeto declara node >=18). */

// Tabela CRC-32 (polinômio padrão 0xEDB88320), calculada uma vez.
const CRC_TABELA = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABELA[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/* Converte Date -> hora/data no formato DOS usado pelo ZIP. */
function dataHoraDos(d) {
  const hora = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xFFFF;
  const data = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF;
  return { hora, data };
}

/**
 * Monta um ZIP a partir de uma lista de { nome, conteudo }.
 * conteudo pode ser string (tratada como UTF-8) ou Buffer.
 * Retorna um Buffer com o arquivo .zip completo.
 */
function criarZip(arquivos, dataMod = new Date()) {
  const { hora, data } = dataHoraDos(dataMod);
  const locais = [];       // pedaços do corpo (local header + dados)
  const central = [];      // entradas do diretório central
  let offset = 0;

  for (const item of arquivos) {
    const nomeBuf = Buffer.from(item.nome, 'utf8');
    const dados = Buffer.isBuffer(item.conteudo) ? item.conteudo : Buffer.from(item.conteudo, 'utf8');
    const crc = crc32(dados);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);   // assinatura local file header
    local.writeUInt16LE(20, 4);           // versão necessária
    local.writeUInt16LE(0x0800, 6);       // flag: nome em UTF-8
    local.writeUInt16LE(0, 8);            // método: 0 = store
    local.writeUInt16LE(hora, 10);
    local.writeUInt16LE(data, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(dados.length, 18); // tamanho comprimido
    local.writeUInt32LE(dados.length, 22); // tamanho original
    local.writeUInt16LE(nomeBuf.length, 26);
    local.writeUInt16LE(0, 28);            // extra field length
    locais.push(local, nomeBuf, dados);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);      // assinatura central directory
    cen.writeUInt16LE(20, 4);              // versão que criou
    cen.writeUInt16LE(20, 6);              // versão necessária
    cen.writeUInt16LE(0x0800, 8);          // flag UTF-8
    cen.writeUInt16LE(0, 10);              // método store
    cen.writeUInt16LE(hora, 12);
    cen.writeUInt16LE(data, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(dados.length, 20);
    cen.writeUInt32LE(dados.length, 24);
    cen.writeUInt16LE(nomeBuf.length, 28);
    cen.writeUInt16LE(0, 30);              // extra
    cen.writeUInt16LE(0, 32);              // comentário
    cen.writeUInt16LE(0, 34);              // disco inicial
    cen.writeUInt16LE(0, 36);              // atributos internos
    cen.writeUInt32LE(0, 38);              // atributos externos
    cen.writeUInt32LE(offset, 42);         // offset do local header
    central.push(cen, nomeBuf);

    offset += local.length + nomeBuf.length + dados.length;
  }

  const corpoCentral = Buffer.concat(central);
  const fim = Buffer.alloc(22);
  fim.writeUInt32LE(0x06054b50, 0);        // end of central directory
  fim.writeUInt16LE(0, 4);                 // disco atual
  fim.writeUInt16LE(0, 6);                 // disco do início do CD
  fim.writeUInt16LE(arquivos.length, 8);   // entradas neste disco
  fim.writeUInt16LE(arquivos.length, 10);  // total de entradas
  fim.writeUInt32LE(corpoCentral.length, 12);
  fim.writeUInt32LE(offset, 16);           // offset do início do CD
  fim.writeUInt16LE(0, 20);                // comentário

  return Buffer.concat([...locais, corpoCentral, fim]);
}

module.exports = { criarZip, crc32 };
