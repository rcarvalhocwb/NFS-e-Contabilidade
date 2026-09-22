#!/usr/bin/env bash
# Espelho em bash de preparar-pacote.ps1, para montar o pacote fora do Windows.
# Mesma lista de inclusao, mesma lista de exclusao, mesma versao de Node --
# test/pacote-limpo.test.js compara as duas listas e falha se divergirem, porque
# uma exclusao que existe so de um lado e um vazamento que sai no .exe calado.
#
# Nao monta o PostgreSQL portatil: equivale a rodar o .ps1 com -SemBanco, e o
# instalador baixa o banco na maquina de destino.
set -euo pipefail

INST="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RAIZ="$(dirname "$INST")"
PACOTE="$INST/pacote"
NODE_VERSAO=22.11.0
DL="${DL:-$INST/.baixados}"

echo "== 1. Preparando a pasta"
rm -rf "$PACOTE"; mkdir -p "$PACOTE"

echo "== 2. Copiando o gateway"
for item in src migrations scripts relay monitor wa \
            package.json package-lock.json .env.example \
            Manutencao.bat Monitor.bat WhatsApp.bat; do
  [ -e "$RAIZ/$item" ] || { echo "nao encontrei $item" >&2; exit 1; }
  cp -a "$RAIZ/$item" "$PACOTE/"
done

for fora in relay/teste relay/dados monitor/sessao.txt \
            scripts/licenca-emitir.js scripts/ensaio-instalacao.js \
            scripts/papel-app.js scripts/criar-escritorio.js \
            wa/node_modules wa/sessao wa/token.txt; do
  rm -rf "$PACOTE/$fora"
done
mkdir -p "$PACOTE/ferramentas"

echo "== 3. Dependencias de producao"
TMPD=$(mktemp -d)
cp "$RAIZ/package.json" "$TMPD/"
cp "$RAIZ/package-lock.json" "$TMPD/" 2>/dev/null || true
( cd "$TMPD" && npm install --omit=dev --no-fund --no-audit --silent >/dev/null 2>&1 )
cp -a "$TMPD/node_modules" "$PACOTE/"
echo "   $(find "$PACOTE/node_modules" -maxdepth 1 -mindepth 1 -type d | wc -l) pacotes"
rm -rf "$TMPD"

echo "== 4. Node.js portatil"
mkdir -p "$PACOTE/node"
TMPN=$(mktemp -d)
ZIP="$DL/node-v$NODE_VERSAO-win-x64.zip"
mkdir -p "$DL"
[ -f "$ZIP" ] || curl -fsSL -o "$ZIP" \
  "https://nodejs.org/dist/v$NODE_VERSAO/node-v$NODE_VERSAO-win-x64.zip"
unzip -q "$ZIP" \
      "node-v$NODE_VERSAO-win-x64/node.exe" -d "$TMPN"
cp "$TMPN/node-v$NODE_VERSAO-win-x64/node.exe" "$PACOTE/node/"
rm -rf "$TMPN"
echo "   node.exe $(du -m "$PACOTE/node/node.exe" | cut -f1) MB"

echo "== 5. PostgreSQL: pulado (equivale a -SemBanco)"

echo "== 6. Arquivos de apoio"
cp "$INST/postgres-local.ps1" "$PACOTE/"
cp "$INST/LEIA-ME.txt" "$PACOTE/"

echo "== 7. Versao"
VERSAO=$(node -p "require('$RAIZ/package.json').version")
[ -n "$VERSAO" ] || { echo "package.json sem version" >&2; exit 1; }
printf '#define Versao "%s"\n' "$VERSAO" > "$INST/versao.iss"
echo "   versao $VERSAO em versao.iss"

echo
echo "Pacote pronto: $PACOTE ($(du -sm "$PACOTE" | cut -f1) MB)"
