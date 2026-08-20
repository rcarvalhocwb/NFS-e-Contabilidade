# Esquemas XSD oficiais da NFS-e nacional

Origem: pacote **NFSe-ESQUEMAS_XSD v1.01 (09/02/2026)**, publicado pela
Secretaria-Executiva do Comitê Gestor da NFS-e em
<https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/documentacao-atual>.

Arquivos copiados sem alteração. Estão versionados aqui porque `test/xsd.test.js`
valida contra eles todo documento que o gateway monta — DPS e pedido de evento.

Sem essa validação, o único juiz do leiaute era a própria Sefin, que só responde
depois de a numeração fiscal ter sido consumida e o documento assinado. Foi assim
que passaram despercebidos, por exemplo, `pAliq` fora de ordem dentro de
`tribMun` e o mínimo de 15 caracteres do `xMotivo`.

## Versões

- `1.00/` — leiaute em uso pelo gateway (DPS `versao="1.00"`).
- `1.01/` — leiaute do RTC, com os grupos IBS/CBS da Reforma Tributária. O
  gateway ainda não emite esses grupos; a pasta está aqui para a comparação
  quando a migração for feita.

O pedido de registro de evento usa `versao="1.01"` desde antes desta cópia — é o
que a Sefin aceita em produção, e o esquema 1.00 do pedido rejeita esse valor.

## Como atualizar

Baixe o pacote novo da página acima, substitua as pastas e rode `npm test`. As
falhas apontam exatamente o que mudou no leiaute.
