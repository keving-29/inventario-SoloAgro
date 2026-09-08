@echo off
setlocal
cd /d "%~dp0"

echo Iniciando firmador local de SoloAgro...
start "SoloAgro - Firmador QZ" powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0SoloAgro-Firmador.ps1"

timeout /t 2 /nobreak >nul

REM CAMBIA ESTA LINEA SOLO SI TU URL DE GITHUB PAGES ES DIFERENTE.
start "" "https://keving-29.github.io/inventario-SoloAgro/"
endlocal
