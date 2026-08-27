#!/usr/bin/env bash
# Sobe uma versao nova do repassador.
#
# Nao toca no .env nem em dados/: o primeiro tem as credenciais e o segundo tem
# a fila de pedidos que ainda nao foram buscados.
#
#   ./implantar.sh usuario@servidor
set -euo pipefail

ALVO="${1:?uso: ./implantar.sh usuario@servidor}"
PASTA=/opt/nfse-relay

echo "→ enviando o codigo para $ALVO"
rsync -az --delete \
  --exclude 'dados/' --exclude '.env' --exclude 'node_modules/' \
  --exclude 'implantar/' \
  ../ "$ALVO:$PASTA/"

echo "→ conferindo a configuracao"
ssh "$ALVO" "test -f $PASTA/.env || { echo 'FALTA o .env em $PASTA'; exit 1; }"

echo "→ reiniciando"
ssh "$ALVO" "sudo systemctl restart nfse-relay && sleep 2 && systemctl is-active nfse-relay"

echo "→ saude"
ssh "$ALVO" "curl -s localhost:8080/saude"
echo
echo "pronto."
