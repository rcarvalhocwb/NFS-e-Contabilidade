# -*- coding: utf-8 -*-
import io


def troca_em(p, pares):
    s = io.open(p, encoding='utf-8', newline='').read()
    nl = '\r\n' if '\r\n' in s else '\n'
    for v, n in pares:
        a, b = v.replace('\n', nl), n.replace('\n', nl)
        assert s.count(a) == 1, (p, repr(v[:60]))
        s = s.replace(a, b)
    io.open(p, 'w', encoding='utf-8', newline='').write(s)


troca_em(r'C:\dev\nfse-gateway\src\services\emissaoService.js', [(
    """  const modo = await municipios.modoDe(empresa.codigo_municipio);
  if (modo === 'proprio') {
    throw Object.assign(new Error(
      `O município ${empresa.codigo_municipio} usa emissor próprio (não emite pelo Sistema Nacional). ` +
      `Emita pela prefeitura ou aguarde a migração para o Nacional.`
    ), { status: 422 });
  }""",
    """  const mun = await municipios.obter(empresa.codigo_municipio);
  if (mun && mun.modo_emissao === 'proprio') {
    /* Dizer só "o município 4107652 não serve" deixa a pessoa com a nota na mão
       e sem saída. O que resolve o problema dela é o nome do lugar e para onde
       ir — por isso o emissor e o portal ficam no cadastro do município. */
    const onde = [
      mun.emissor ? `pelo ${mun.emissor}` : 'pelo sistema da prefeitura',
      mun.url_portal ? `(${mun.url_portal})` : ''
    ].filter(Boolean).join(' ');

    throw Object.assign(new Error(
      `${mun.nome || 'Este município'} (${empresa.codigo_municipio}) não emite pelo ` +
      `Sistema Nacional: mantém emissor próprio. A nota desta empresa sai ${onde}. ` +
      (mun.observacao ? mun.observacao : 'Confira o credenciamento junto à prefeitura.')
    ), { status: 422 });
  }""")])
print('emissaoService: bloqueio com destino')
