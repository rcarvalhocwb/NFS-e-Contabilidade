@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
title Monitor do NFS-e Gateway

rem  Abre o monitor do gateway.
rem
rem  Sao dois programas de proposito: o gateway emite as notas, o monitor olha.
rem  Um monitor que morre junto com o que ele monitora nao serve para nada --
rem  e justamente quando o gateway cai que alguem quer olhar.
rem
rem  Ele sobe ELEVADO, porque so assim consegue ligar e desligar o gateway. Mas
rem  o navegador e aberto pelo explorer.exe, que roda com a conta normal: nao
rem  se navega como administrador por causa de um painel local.

rem ---------------------------------------------------- elevar, se preciso
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo   Abrindo o monitor.
    echo.
    echo   Vai aparecer uma janela azul pedindo confirmacao: clique em "Sim".
    echo   E dela que vem a permissao para ligar e desligar o gateway.
    echo.
    timeout /t 2 >nul
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

cd /d "%~dp0"

set "NODE=node.exe"
if exist "%~dp0node\node.exe" set "NODE=%~dp0node\node.exe"

rem  Token novo a cada abertura. Sem ele, qualquer programa da maquina que
rem  falasse com a porta poderia parar a emissao do escritorio.
for /f %%t in ('powershell -NoProfile -Command "[guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')"') do set "TOKEN=%%t"
set "MONITOR_TOKEN=%TOKEN%"

echo.
echo   Subindo o monitor...
start "" /b "%NODE%" "%~dp0monitor\servidor.js"

rem  Espera a porta atender antes de abrir o navegador: abrir antes mostraria
rem  "nao foi possivel acessar" e a pessoa acharia que quebrou.
set "PRONTO="
for /l %%i in (1,1,20) do (
    if not defined PRONTO (
        timeout /t 1 >nul
        powershell -NoProfile -Command "try { (New-Object Net.Sockets.TcpClient('127.0.0.1',3100)).Close(); exit 0 } catch { exit 1 }" >nul 2>&1
        if !errorlevel! equ 0 set "PRONTO=1"
    )
)

if not defined PRONTO (
    echo.
    echo   O monitor nao subiu. Confira se o Node esta instalado na pasta do gateway.
    pause
    exit /b 1
)

rem  Se o monitor ja estava aberto de antes, o token valido e o que ele gravou.
if exist "%~dp0monitor\sessao.txt" (
    for /f "usebackq delims=" %%s in ("%~dp0monitor\sessao.txt") do set "TOKEN=%%s"
)

rem  explorer.exe abre com a conta normal, nao como administrador.
explorer.exe "http://127.0.0.1:3100/?t=%TOKEN%"

echo.
echo   Monitor aberto no navegador.
echo   Pode fechar esta janela preta: o monitor continua rodando.
echo.
timeout /t 6 >nul
