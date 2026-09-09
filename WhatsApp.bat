@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
title WhatsApp do NFS-e Gateway

rem  Abre o modulo do WhatsApp.
rem
rem  Sao dois programas de proposito: o gateway emite as notas, este mantem a
rem  sessao do WhatsApp. A sessao cai, reconecta e as vezes morre por decisao
rem  de terceiro -- dentro do gateway, cada um desses acidentes seria um
rem  acidente do sistema fiscal. Aqui fora, o pior que acontece e o WhatsApp
rem  parar, e a emissao pelo painel nem fica sabendo.
rem
rem  NAO precisa de administrador: ele nao mexe em servico nem em firewall,
rem  so faz conexao de saida. Rodar elevado seria pedir permissao que nao usa.

cd /d "%~dp0"

set "NODE=node.exe"
if exist "%~dp0node\node.exe" set "NODE=%~dp0node\node.exe"

rem ------------------------------------------------- as dependencias do modulo
rem
rem  Elas NAO vao no instalador: sao 113 MB, e so quem escolhe usar o WhatsApp
rem  por sessao propria precisa delas. Quem usa a API oficial da Meta, ou nao
rem  usa WhatsApp, nao carrega esse peso.
if not exist "%~dp0wa\node_modules" (
    echo.
    echo   Primeira vez: preciso baixar as bibliotecas do WhatsApp.
    echo.
    echo   Sao cerca de 113 MB e leva alguns minutos. Isso acontece uma vez so.
    echo   E preciso internet agora.
    echo.
    pushd "%~dp0wa"
    call npm install --omit=dev --no-audit --no-fund
    if errorlevel 1 (
        popd
        echo.
        echo   NAO CONSEGUI BAIXAR. Verifique a internet e tente de novo.
        echo.
        echo   Se esta maquina nao tem npm, o modulo do WhatsApp por sessao
        echo   propria nao vai funcionar aqui -- mas a API oficial da Meta e a
        echo   emissao de notas continuam normais.
        echo.
        pause
        exit /b 1
    )
    popd
    echo.
    echo   Pronto.
    echo.
)

rem  Porta do modulo. Se voce mudou na tela do painel, mude aqui tambem.
if "%WA_PORTA%"=="" set "WA_PORTA=3200"
if "%WA_GATEWAY%"=="" set "WA_GATEWAY=http://127.0.0.1:3000"

echo.
echo   Iniciando o modulo do WhatsApp...
echo.
echo   ATENCAO: isto usa automacao NAO OFICIAL do WhatsApp. O numero pode ser
echo   banido pelo WhatsApp, e nao ha a quem recorrer. A emissao de notas
echo   fiscais NAO depende deste modulo.
echo.

rem  O modulo escreve o token num arquivo ao subir. Esperamos ele aparecer para
rem  abrir o navegador ja autenticado -- ninguem digita token.
if exist "%~dp0wa\token.txt" del "%~dp0wa\token.txt" >nul 2>&1

start "" /b "%NODE%" "%~dp0wa\servidor.js"

set "TENTATIVAS=0"
:esperar
if exist "%~dp0wa\token.txt" goto abrir
set /a TENTATIVAS+=1
if %TENTATIVAS% gtr 60 (
    echo.
    echo   O modulo nao subiu. Veja a janela preta para o motivo.
    echo.
    pause
    exit /b 1
)
timeout /t 1 >nul
goto esperar

:abrir
set /p TOKEN=<"%~dp0wa\token.txt"

rem  explorer.exe abre o navegador com a conta normal do usuario: nao se navega
rem  como administrador por causa de um painel local.
explorer.exe "http://127.0.0.1:%WA_PORTA%/?t=%TOKEN%"

echo.
echo   A tela abriu no navegador.
echo.
echo   NAO FECHE ESTA JANELA: e ela que mantem o WhatsApp conectado.
echo   Para desligar, feche esta janela ou use o botao na tela.
echo.

rem  Segura o console: fechar aqui derruba o modulo, e e assim que se desliga.
pause >nul
