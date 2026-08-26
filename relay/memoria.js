const fs = require('fs');
const path = require('path');

/* O que o relay guarda — e, principalmente, o que ele NÃO guarda.
 *
 * GUARDA: o retrato do cadastro que o gateway manda (empresas, serviços, quem
 * pode pedir), a conversa em andamento de cada número, e os pedidos que ainda
 * não foram buscados pelo gateway.
 *
 * NÃO GUARDA: certificado, senha, XML de nota, PDF, numeração fiscal. Nada
 * disso passa por aqui. Quando a nota fica pronta, o cliente recebe o link da
 * consulta pública da Sefin — que é o mesmo endereço do QR Code impresso na
 * nota, público por natureza. Documento fiscal nenhum transita nesta máquina.
 *
 * Arquivo JSON e não banco: o volume é de centenas de pedidos por mês, e o
 * conteúdo é transitório — pedido buscado pelo gateway some daqui. Instalar e
 * manter um Postgres para isso seria peso sem retorno. A gravação é atômica
 * (escreve ao lado e renomeia), senão um desligamento no meio deixaria o
 * arquivo pela metade e o relay subiria sem cadastro nenhum.
 */

const VAZIO = {
  cadastro: null,           // último retrato recebido do gateway
  vistas: {},               // wamid -> quando, contra reenvio de POST assinado
  conversas: {},            // telefone -> { estado, dados, em }
  pedidos: [],              // fila para o gateway buscar
  resultados: {},           // idPedido -> desfecho, até a resposta sair
  atualizadoEm: null
};

/* Conversa parada é conversa esquecida: quem começou e sumiu não deve voltar
   três dias depois no meio de um pedido, com valores que já não fazem sentido.
   E a janela de serviço da Meta é de 24 horas de todo jeito. */
const CONVERSA_EXPIRA_MS = 30 * 60 * 1000;

class Memoria {
  constructor(arquivo) {
    this.arquivo = arquivo || path.join(__dirname, 'dados', 'relay.json');
    this.dados = JSON.parse(JSON.stringify(VAZIO));
    this.carregar();
  }

  carregar() {
    try {
      const bruto = fs.readFileSync(this.arquivo, 'utf8');
      this.dados = Object.assign(JSON.parse(JSON.stringify(VAZIO)), JSON.parse(bruto));
    } catch (e) {
      if (e.code !== 'ENOENT') {
        console.error('[memoria] arquivo ilegível, começando vazio:', e.message);
      }
    }
  }

  salvar() {
    fs.mkdirSync(path.dirname(this.arquivo), { recursive: true });
    this.dados.atualizadoEm = new Date().toISOString();
    const temporario = this.arquivo + '.tmp';
    fs.writeFileSync(temporario, JSON.stringify(this.dados, null, 1), 'utf8');
    fs.renameSync(temporario, this.arquivo);   // atômico no mesmo volume
  }

  // ------------------------------------------------------------- cadastro

  guardarCadastro(retrato) {
    this.dados.cadastro = retrato;
    this.salvar();
  }

  /* Por quais empresas este número pode pedir nota?
     Lista, não uma só: a mesma pessoa costuma cuidar de várias empresas do
     grupo, e obrigá-la a três chips não é solução — é o que faz ela dar um
     jeito por fora. Sem vínculo nenhum, o número não é ninguém. */
  empresasDe(telefone) {
    const c = this.dados.cadastro;
    if (!c) return [];
    const formas = variacoesDoNumero(telefone);
    return (c.whatsapp || [])
      .filter(w => formas.includes(w.telefone))
      .map(contato => {
        const empresa = (c.empresas || []).find(e => e.cnpj === contato.cnpj);
        return empresa && empresa.ativo ? { contato, empresa } : null;
      })
      .filter(Boolean);
  }

  /* Confere que a empresa escolhida é MESMO uma das que o número pode usar.
     A escolha chega como texto do cliente — número da lista ou CNPJ digitado —
     e texto de cliente nunca vira autorização sozinho. */
  conferirEscolha(telefone, escolhaCnpj) {
    return this.empresasDe(telefone)
      .find(x => x.empresa.cnpj === String(escolhaCnpj || '').replace(/[^0-9A-Za-z]/g, '')) || null;
  }

  /* Mensagem já vista não vale de novo.
   *
   * A assinatura da Meta prova que o corpo veio dela — e continua provando para
   * sempre. Quem capturar um POST assinado (log de proxy, backup mal guardado)
   * pode reenviá-lo quantas vezes quiser. O wamid é único na Meta: visto uma
   * vez, ignorado nas seguintes. */
  jaVi(idMensagem) {
    if (!idMensagem) return false;
    const vistas = this.dados.vistas || (this.dados.vistas = {});
    if (vistas[idMensagem]) return true;
    vistas[idMensagem] = Date.now();
    // Só o que é recente importa; o resto já não pode ser replay útil
    const corte = Date.now() - 24 * 3600 * 1000;
    for (const k of Object.keys(vistas)) if (vistas[k] < corte) delete vistas[k];
    this.salvar();
    return false;
  }

  servicosDa(cnpj) {
    return ((this.dados.cadastro || {}).servicos || []).filter(s => s.cnpj === cnpj);
  }

  // ------------------------------------------------------------ conversa

  conversaDe(telefone) {
    const c = this.dados.conversas[telefone];
    if (!c) return null;
    if (Date.now() - new Date(c.em).getTime() > CONVERSA_EXPIRA_MS) {
      delete this.dados.conversas[telefone];
      return null;
    }
    return c;
  }

  guardarConversa(telefone, estado, dados) {
    this.dados.conversas[telefone] = {
      estado, dados: dados || {}, em: new Date().toISOString()
    };
    this.salvar();
  }

  esquecerConversa(telefone) {
    delete this.dados.conversas[telefone];
    this.salvar();
  }

  // -------------------------------------------------------------- pedidos

  enfileirar(pedido) {
    this.dados.pedidos.push(pedido);
    this.salvar();
    return pedido;
  }

  /* O gateway busca, mas não confirma o recebimento numa chamada separada — ele
     devolve o desfecho depois. Então o pedido fica na fila até o desfecho
     chegar: se a conexão cair no meio, a próxima busca traz de novo, e o
     id_externo único do outro lado impede virar duas notas. */
  pendentes(limite) {
    return this.dados.pedidos.slice(0, Math.min(Number(limite) || 10, 100));
  }

  concluir(id, desfecho) {
    const i = this.dados.pedidos.findIndex(p => p.id === id);
    const pedido = i >= 0 ? this.dados.pedidos[i] : null;
    if (i >= 0) this.dados.pedidos.splice(i, 1);
    this.dados.resultados[id] = {
      desfecho, pedido, em: new Date().toISOString()
    };
    this.limparResultadosVelhos();
    this.salvar();
    return pedido;
  }

  /* Desfecho já avisado ao cliente não precisa ficar. Uma semana cobre a dúvida
     de "e aquela nota de terça?" sem deixar o arquivo crescer para sempre. */
  limparResultadosVelhos() {
    const corte = Date.now() - 7 * 24 * 3600 * 1000;
    for (const id of Object.keys(this.dados.resultados)) {
      if (new Date(this.dados.resultados[id].em).getTime() < corte) {
        delete this.dados.resultados[id];
      }
    }
  }
}

/* Mesma regra do gateway: celular brasileiro pode chegar com ou sem o nono
   dígito, e comparar texto com texto erraria metade das vezes. */
function variacoesDoNumero(bruto) {
  const d = String(bruto || '').replace(/\D/g, '');
  if (!d) return [];
  const formas = new Set([d]);
  if (d.startsWith('55') && d.length === 13 && d[4] === '9') {
    formas.add('55' + d.slice(2, 4) + d.slice(5));
  }
  if (d.startsWith('55') && d.length === 12 && /^[6-9]/.test(d.slice(4))) {
    formas.add('55' + d.slice(2, 4) + '9' + d.slice(4));
  }
  return [...formas];
}

module.exports = { Memoria, variacoesDoNumero, CONVERSA_EXPIRA_MS };
