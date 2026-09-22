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

rem ------------------------------------------------- pasta de dados gravavel
rem
rem  A pasta de instalacao (Arquivos de Programas) e so-leitura para quem nao e
rem  administrador. Escrever ali -- node_modules, token, sessao -- estourava com
rem  EPERM. Os dados que mudam vao para LocalAppData, sempre gravavel pelo
rem  usuario, e o codigo continua sendo lido da pasta de instalacao.
rem  ProgramData (nao LocalAppData): a pasta e a MESMA para o modulo e para o
rem  gateway, que le o token dali. LocalAppData e por usuario e os dois
rem  processos poderiam divergir. src/util/dados.js resolve igual do lado do node.
if "%NFSE_WA_DADOS%"=="" set "NFSE_WA_DADOS=%PROGRAMDATA%\NFSe Gateway\wa"
if not exist "%NFSE_WA_DADOS%" mkdir "%NFSE_WA_DADOS%" >nul 2>&1

rem ------------------------------------------------- as dependencias do modulo
rem
rem  Sao 113 MB que so quem usa sessao propria precisa. Se o instalador ja as
rem  deixou na pasta de instalacao (passo elevado), usamos de la -- ler basta
rem  para o require(), e nao se escreve nada ali. Se nao, baixamos para a pasta
rem  de dados (gravavel sem administrador). NODE_PATH diz ao node onde procurar.
set "NODE_PATH=%~dp0wa\node_modules"
if not exist "%~dp0wa\node_modules" (
    set "NODE_PATH=%NFSE_WA_DADOS%\node_modules"
    if not exist "%NFSE_WA_DADOS%\node_modules" (
        echo.
        echo   Primeira vez: preciso baixar as bibliotecas do WhatsApp.
        echo.
        echo   Sao cerca de 113 MB e leva alguns minutos. Isso acontece uma vez so.
        echo   E preciso internet agora.
        echo.
        copy /y "%~dp0wa\package.json" "%NFSE_WA_DADOS%\" >nul 2>&1
        if exist "%~dp0wa\package-lock.json" copy /y "%~dp0wa\package-lock.json" "%NFSE_WA_DADOS%\" >nul 2>&1
        pushd "%NFSE_WA_DADOS%"
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

rem  O modulo escreve o token num arquivo (na pasta de dados) ao subir.
rem  Esperamos ele aparecer para abrir o navegador ja autenticado.
set "ARQ_TOKEN=%NFSE_WA_DADOS%\token.txt"
if exist "%ARQ_TOKEN%" del "%ARQ_TOKEN%" >nul 2>&1

start "" /b "%NODE%" "%~dp0wa\servidor.js"

set "TENTATIVAS=0"
:esperar
if exist "%ARQ_TOKEN%" goto abrir
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
set /p TOKEN=<"%ARQ_TOKEN%"

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
