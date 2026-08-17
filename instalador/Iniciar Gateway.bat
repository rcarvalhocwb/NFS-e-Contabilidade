@echo off
REM ---------------------------------------------------------------------
REM Inicia o NFS-e Gateway e abre o navegador na tela de emissao.
REM
REM Este arquivo usa apenas caracteres ASCII de proposito: o cmd.exe le em
REM codepage legada, e acentos ou travessoes quebram o interpretador, que
REM passa a executar pedacos de texto como se fossem comandos.
REM ---------------------------------------------------------------------
title NFS-e Gateway
cd /d "%~dp0.."

echo.
echo   =============================================
echo      NFS-e Gateway
echo   =============================================
echo.

REM Sem o Node nada funciona: avisa em vez de fechar sozinho.
where node >nul 2>&1
if errorlevel 1 (
    echo   [X] O Node.js nao foi encontrado.
    echo.
    echo   Execute o arquivo "instalar.ps1" da pasta instalador
    echo   ou instale o Node.js em https://nodejs.org
    echo.
    pause
    exit /b 1
)

if not exist ".env" (
    echo   [X] O gateway ainda nao foi configurado.
    echo.
    echo   Clique com o botao direito em "instalador\instalar.ps1"
    echo   e escolha "Executar com o PowerShell".
    echo.
    pause
    exit /b 1
)

echo   Iniciando... aguarde alguns segundos.
echo.

REM Banco de dados nesta maquina: sobe antes do gateway. Se o gateway usa um
REM servidor externo, a pasta abaixo nao existe e este trecho e ignorado.
set PGCTL=%~dp0postgres\pgsql\bin\pg_ctl.exe
if exist "%PGCTL%" (
    echo   Abrindo o banco de dados...
    powershell -NoProfile -ExecutionPolicy Bypass -Command ". '%~dp0postgres-local.ps1'; if (-not (Start-PostgresLocal '%~dp0')) { exit 1 }"
    if errorlevel 1 (
        echo   [X] O banco de dados nao quis iniciar.
        echo       Veja o arquivo instalador\postgres\postgres.log
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

node src/server.js

REM Fecha o banco junto com o gateway. Sem isso ele ficaria rodando em segundo
REM plano depois que a janela fosse fechada.
if exist "%PGCTL%" (
    echo.
    echo   Fechando o banco de dados...
    powershell -NoProfile -ExecutionPolicy Bypass -Command ". '%~dp0postgres-local.ps1'; Stop-PostgresLocal '%~dp0' | Out-Null"
)

REM Se chegou aqui, o servidor caiu: mostra o motivo em vez de sumir.
echo.
echo   ---------------------------------------------
echo   O gateway foi encerrado.
echo.
pause
