@echo off
setlocal
chcp 65001 >nul
title Manutencao do NFS-e Gateway

rem  Manutencao do gateway, para quem nao escreve comandos.
rem
rem  Registrar tarefa e servico exige privilegio de administrador, e uma pagina
rem  web nao consegue pedir isso ao Windows -- o UAC so aparece para um
rem  programa. Entao o que a tela do painel nao pode fazer, este arquivo faz:
rem  dois cliques, "Sim" na janela azul, e um menu em portugues.
rem
rem  Nao ha nada aqui que o painel ja resolva sozinho. Isto e a ponte para o
rem  que so o Windows autoriza.

rem ---------------------------------------------------- elevar, se preciso
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo   Preciso de permissao de administrador para mexer no
    echo   inicio automatico do Windows.
    echo.
    echo   Vai aparecer uma janela azul pedindo confirmacao. Clique em "Sim".
    echo.
    timeout /t 3 >nul
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

cd /d "%~dp0"
set "PS=powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\servico-windows.ps1"

:menu
cls
echo.
echo   ============================================================
echo      NFS-e Gateway  -  Manutencao
echo   ============================================================
echo.
echo      1  Ver como esta          (tarefa, banco, gateway, backup)
echo.
echo      2  Instalar o inicio automatico
echo         O gateway e o banco passam a subir junto com o Windows.
echo         Use tambem depois de atualizar o sistema.
echo.
echo      3  Reiniciar o gateway
echo         Necessario depois de uma atualizacao.
echo.
echo      4  Parar o gateway
echo         Ele fica fora do ar ate ser iniciado de novo. O WhatsApp
echo         nao responde e nenhuma nota e emitida enquanto isso.
echo.
echo      5  Iniciar o gateway
echo.
echo      0  Sair
echo.
set "op="
set /p "op=   Digite o numero e tecle Enter: "

if "%op%"=="1" ( %PS% situacao & pause & goto menu )
if "%op%"=="2" ( %PS% instalar & pause & goto menu )
if "%op%"=="3" ( goto reiniciar )
if "%op%"=="4" ( goto parar )
if "%op%"=="5" ( %PS% iniciar & pause & goto menu )
if "%op%"=="0" ( exit /b )
goto menu

:reiniciar
echo.
%PS% parar
timeout /t 3 >nul
%PS% iniciar
echo.
echo   Conferindo...
timeout /t 5 >nul
%PS% situacao
pause
goto menu

:parar
echo.
echo   ATENCAO: com o gateway parado, nenhuma nota e emitida e o
echo            WhatsApp nao responde a ninguem.
echo.
set "c="
set /p "c=   Tem certeza? Digite SIM para confirmar: "
if /i not "%c%"=="SIM" goto menu
%PS% parar
pause
goto menu
