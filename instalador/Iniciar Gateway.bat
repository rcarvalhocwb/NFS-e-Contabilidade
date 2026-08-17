@echo off
REM ---------------------------------------------------------------------
REM Inicia o NFS-e Gateway e abre o navegador na tela de emissao.
REM
REM Este arquivo usa apenas caracteres ASCII de proposito: o cmd.exe le em
REM codepage legada, e acentos ou travessoes quebram o interpretador, que
REM passa a executar pedacos de texto como se fossem comandos.
REM
REM Funciona nos dois layouts: instalado pelo .exe (este arquivo fica na
REM raiz) ou copiado a mao (fica dentro de instalador\).
REM ---------------------------------------------------------------------
title NFS-e Gateway

REM Descobre a raiz do gateway: aqui mesmo, ou um nivel acima.
if exist "%~dp0src\server.js" (
    set "RAIZ=%~dp0"
) else if exist "%~dp0..\src\server.js" (
    pushd "%~dp0.." & set "RAIZ=%CD%\" & popd
) else (
    echo   [X] Nao encontrei os arquivos do gateway.
    echo       Reinstale o programa.
    pause
    exit /b 1
)
cd /d "%RAIZ%"

echo.
echo   =============================================
echo      NFS-e Gateway
echo   =============================================
echo.

REM Node embutido pelo instalador; se nao houver, usa o do sistema.
set "NODE=%RAIZ%node\node.exe"
if not exist "%NODE%" set "NODE=node"
if "%NODE%"=="node" (
    where node >nul 2>&1
    if errorlevel 1 (
        echo   [X] O Node.js nao foi encontrado.
        echo.
        echo   Reinstale o gateway pelo instalador, que ja o inclui,
        echo   ou instale o Node.js em https://nodejs.org
        echo.
        pause
        exit /b 1
    )
)

if not exist ".env" (
    echo   [X] O gateway ainda nao foi configurado.
    echo.
    echo   Execute o instalador novamente.
    echo.
    pause
    exit /b 1
)

echo   Iniciando... aguarde alguns segundos.
echo.

REM Banco nesta maquina: sobe antes do gateway. Procura nos dois layouts.
set "PGDIR=%RAIZ%"
if exist "%RAIZ%instalador\postgres\pgsql\bin\pg_ctl.exe" set "PGDIR=%RAIZ%instalador\"
set "PGCTL=%PGDIR%postgres\pgsql\bin\pg_ctl.exe"
set "PGPS1=%PGDIR%postgres-local.ps1"
if not exist "%PGPS1%" set "PGPS1=%RAIZ%postgres-local.ps1"

if exist "%PGCTL%" (
    echo   Abrindo o banco de dados...
    powershell -NoProfile -ExecutionPolicy Bypass -Command ". '%PGPS1%'; if (-not (Start-PostgresLocal '%PGDIR%')) { exit 1 }"
    if errorlevel 1 (
        echo   [X] O banco de dados nao quis iniciar.
        echo       Veja postgres\postgres.log
        echo.
        pause
        exit /b 1
    )
)

REM Abre o navegador em paralelo: o servidor leva alguns segundos para
REM responder, e a espera acontece enquanto ele sobe.
start "" /b cmd /c "timeout /t 4 /nobreak >nul & start http://localhost:3000/emitir"

echo   O gateway esta rodando.
echo.
echo   * O navegador vai abrir automaticamente
echo   * Para EMITIR notas:  http://localhost:3000/emitir
echo   * Para CONFIGURAR:    http://localhost:3000/admin
echo.
echo   NAO FECHE ESTA JANELA enquanto estiver usando o gateway.
echo   Para encerrar, feche esta janela ou pressione Ctrl+C.
echo.
echo   ---------------------------------------------
echo.

"%NODE%" src/server.js

REM Fecha o banco junto com o gateway. Sem isso ele ficaria rodando em segundo
REM plano depois que a janela fosse fechada.
if exist "%PGCTL%" (
    echo.
    echo   Fechando o banco de dados...
    powershell -NoProfile -ExecutionPolicy Bypass -Command ". '%PGPS1%'; Stop-PostgresLocal '%PGDIR%' | Out-Null"
)

REM Se chegou aqui, o servidor caiu: mostra o motivo em vez de sumir.
echo.
echo   ---------------------------------------------
echo   O gateway foi encerrado.
echo.
pause
