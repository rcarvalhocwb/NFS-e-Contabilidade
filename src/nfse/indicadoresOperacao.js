/* Indicadores de operação do IBS/CBS (cIndOp).
 *
 * Tabela do Anexo VII — indOp v1.02.00, da documentação técnica da NFS-e.
 * São os códigos que dizem QUAL operação está sendo praticada, e a Sefin
 * valida contra esta lista: um código inventado é recusado mesmo tendo os seis
 * dígitos que o esquema pede.
 *
 * Está embutida em vez de digitada porque o campo tem seis dígitos sem
 * significado mnemônico — "020201" não lembra nada, e errar um dígito troca a
 * natureza da operação.
 *
 * Quando a Sefin publicar uma versão nova do Anexo VII, regere este arquivo:
 *   node scripts/gerar-indop.js .notas-tecnicas/.../anexovii-indop_*.xlsx
 */
const INDICADORES_OPERACAO = [
  {
    "codigo": "010101",
    "tipo": "Bem Móvel Material",
    "caracteristica": "Presencial, com retirada no estabelecimento do fornecedor"
  },
  {
    "codigo": "010102",
    "tipo": "Bem Móvel Material",
    "caracteristica": "Presencial, com retirada fora do estabelecimento do fornecedor"
  },
  {
    "codigo": "010103",
    "tipo": "Bem Móvel Material",
    "caracteristica": "Não presencial, com entrega ou disponibilização em endereço fornecido"
  },
  {
    "codigo": "010104",
    "tipo": "Bem Móvel Material",
    "caracteristica": "Licitação promovida pelo poder público de bem apreendido ou abandonado ou leilão judicial"
  },
  {
    "codigo": "010105",
    "tipo": "Bem Móvel Material",
    "caracteristica": "Constatação de irregularidade pela falta de documentação fiscal ou pelo acobertamento por documentação inidôneo"
  },
  {
    "codigo": "010106",
    "tipo": "Bem Móvel Material",
    "caracteristica": "Locação de bem móvel material em aquisições realizadas de forma centralizada por contribuinte sujeito ao regime regular do IBS e da CBS que possui mais de um estabelecimento e que não estejam sujeitas a vedação à apropriação de créditos"
  },
  {
    "codigo": "010201",
    "tipo": "Aquisição de veículo automotor terrestre, aquático ou aéreo",
    "caracteristica": "Entrega ou disponibilização do bem"
  },
  {
    "codigo": "010202",
    "tipo": "Aquisição de veículo automotor em licitação promovida pelo poder público de bem apreendido ou abandonado ou leilão judicial",
    "caracteristica": "Entrega ou disponibilização do bem"
  },
  {
    "codigo": "020101",
    "tipo": "Operação com bem imóvel, bem imaterial, inclusive direito, relacionada a bem imóvel",
    "caracteristica": "Realização de operações com bem imóvel, bem imaterial, inclusive direito, relacionado a bem imóvel"
  },
  {
    "codigo": "020201",
    "tipo": "Serviço prestado fisicamente sobre bem imóvel",
    "caracteristica": "Execução de serviços diversos prestados fisicamente sobre bem imóvel"
  },
  {
    "codigo": "020202",
    "tipo": "Serviço prestado fisicamente sobre bem imóvel",
    "caracteristica": "Execução de serviços sobre Bens Imóveis de Características Especiais (BICE)"
  },
  {
    "codigo": "020301",
    "tipo": "Serviço de administração e intermediação de bem imóvel",
    "caracteristica": "Execução dos serviços de administração e intermediação de bens imóveis"
  },
  {
    "codigo": "020401",
    "tipo": "Serviços de locação, sublocação, arrendamento, direito de passagem ou permissão de uso, compartilhado ou não, de ferrovia, rodovia, postes, cabos, dutos e condutos de qualquer natureza",
    "caracteristica": "Execução de serviços sobre Bens Imóveis de Características Especiais (BICE)"
  },
  {
    "codigo": "030101",
    "tipo": "Serviço prestado fisicamente sobre a pessoa ou fruído presencialmente por pessoa física",
    "caracteristica": "Execução de serviços diversos exclusivamente prestados fisicamente sobre a pessoa ou integralmente fruídos presencialmente por pessoa física"
  },
  {
    "codigo": "030102",
    "tipo": "Serviço prestado fisicamente sobre a pessoa ou fruído presencialmente por pessoa física",
    "caracteristica": "Execução de serviços diversos exclusivamente prestados fisicamente sobre a pessoa ou integralmente fruídos presencialmente por pessoa física"
  },
  {
    "codigo": "040101",
    "tipo": "Serviço de planejamento, organização e administração de feiras, exposições, congressos, espetáculos, exibições e congêneres",
    "caracteristica": "Execução de serviços de planejamento, organização e administração de feiras, exposições, congressos, espetáculos, exibições e congêneres"
  },
  {
    "codigo": "050101",
    "tipo": "Serviço prestado fisicamente sobre bem móvel material",
    "caracteristica": "Execução de serviços diversos prestados fisicamente sobre bem móvel material"
  },
  {
    "codigo": "050102",
    "tipo": "Serviço prestado fisicamente sobre bem móvel material",
    "caracteristica": "Execução de serviços diversos prestados fisicamente sobre bem móvel material"
  },
  {
    "codigo": "050201",
    "tipo": "Serviços portuários",
    "caracteristica": "Execução de serviços portuários"
  },
  {
    "codigo": "060101",
    "tipo": "Serviço de transporte de passageiros",
    "caracteristica": "Execução de serviços de transporte de passageiros"
  },
  {
    "codigo": "070101",
    "tipo": "Serviço de transporte de carga",
    "caracteristica": "Execução de serviço de transporte de carga"
  },
  {
    "codigo": "070102",
    "tipo": "Serviço de transporte de carga",
    "caracteristica": "Execução de serviço de transporte de carga"
  },
  {
    "codigo": "080101",
    "tipo": "Serviço de exploração de via",
    "caracteristica": "Execução de serviços de exploração de via"
  },
  {
    "codigo": "090101",
    "tipo": "Serviço de telefonia fixa e demais serviços de comunicação prestados por meio de cabos, fios, fibras e meios similares",
    "caracteristica": "Execução de serviços de telefonia fixa e demais serviços de comunicação prestados por meio de cabos, fios, fibras e meios similares"
  },
  {
    "codigo": "090102",
    "tipo": "Serviço de telefonia fixa e demais serviços de comunicação prestados por meio de cabos, fios, fibras e meios similares",
    "caracteristica": "Execução de serviços de telefonia fixa e demais serviços de comunicação prestados por meio de cabos, fios, fibras e meios similares"
  },
  {
    "codigo": "100101",
    "tipo": "Cessão de espaço para prestação de serviços publicitários, em operações onerosas",
    "caracteristica": "Realização de operações de cessão de espaço para prestação de serviços publicitários"
  },
  {
    "codigo": "100102",
    "tipo": "Cessão de espaço para prestação de serviços publicitários, em operações onerosas",
    "caracteristica": "Realização de operações de cessão de espaço para prestação de serviços publicitários"
  },
  {
    "codigo": "100201",
    "tipo": "Cessão de espaço para prestação de serviços publicitários, em operações não onerosas",
    "caracteristica": "Realização de operações de cessão de espaço para prestação de serviços publicitários"
  },
  {
    "codigo": "100301",
    "tipo": "Demais serviços, em operações onerosas",
    "caracteristica": "Execução dos demais serviços em operações não especificadas em outros indicadores ou, nos serviços de que trata o inc. III do art. 11, esses sejam, ainda que parcialmente, prestados à distância"
  },
  {
    "codigo": "100302",
    "tipo": "Demais serviços, em operações onerosas",
    "caracteristica": "Execução dos demais serviços em operações não especificadas em outros indicadores ou, nos serviços de que trata o inc. III do art. 11, esses sejam, ainda que parcialmente, prestados à distância"
  },
  {
    "codigo": "100401",
    "tipo": "Demais serviços, em operações não onerosas",
    "caracteristica": "Execução dos demais serviços em operações não especificadas em outros indicadores ou, nos serviços de que tratam o inc. III, estes sejam, ainda que parcialmente, prestados à distância"
  },
  {
    "codigo": "100501",
    "tipo": "Demais bens, em operações onerosas",
    "caracteristica": "Realização de demais operações com bens não especificadas em outros indicadores"
  },
  {
    "codigo": "100502",
    "tipo": "Demais bens, em operações onerosas",
    "caracteristica": "Realização de demais operações com bens não especificadas em outros indicadores"
  },
  {
    "codigo": "100601",
    "tipo": "Demais bens, em operações não onerosas",
    "caracteristica": "Realização de demais operações com bens não especificadas em outros indicadores"
  },
  {
    "codigo": "110101",
    "tipo": "Operações com abastecimento de água, gás canalizado e energia elétrica",
    "caracteristica": "Operações destinadas a consumo"
  },
  {
    "codigo": "110201",
    "tipo": "Operações com abastecimento de água, gás canalizado e energia elétrica",
    "caracteristica": "Operações que não envolvam efetivo consumo: a) no fornecimento de serviços de transmissão de energia elétrica; e b) nas demais operações, inclusive nas hipóteses de geração, distribuição ou comercialização de energia elétrica."
  },
  {
    "codigo": "120101",
    "tipo": "Nas aquisições de energia elétrica realizadas de forma multilateral",
    "caracteristica": "Disponibilização de energia elétrica"
  },
  {
    "codigo": "130101",
    "tipo": "Operações de transporte dutoviário de gás natural",
    "caracteristica": "Execução do transporte dutoviário de gás natural, na contratação de capacidade de entrada de gás natural do duto, nos termos da legislação aplicável"
  },
  {
    "codigo": "130201",
    "tipo": "Operações de transporte dutoviário de gás natural",
    "caracteristica": "Execução do transporte dutoviário de gás natural, na contratação de capacidade de saída do gás natural do duto"
  }
];

/* Serviço, que é o que uma NFS-e documenta, vive nas faixas 02 a 13; a faixa
   01 é de bem móvel material, que sai por NF-e. */
function paraServicos() {
  return INDICADORES_OPERACAO.filter(i => !i.codigo.startsWith('01'));
}

function existe(codigo) {
  return INDICADORES_OPERACAO.some(i => i.codigo === String(codigo));
}

function descrever(codigo) {
  const i = INDICADORES_OPERACAO.find(x => x.codigo === String(codigo));
  return i ? i.tipo : null;
}

module.exports = { INDICADORES_OPERACAO, paraServicos, existe, descrever };
