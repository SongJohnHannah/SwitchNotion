@echo off
chcp 65001 >nul
echo ==================================================
echo   Transcriber - http://localhost:3066
echo ==================================================
echo.
C:\Users\songf\.pyenv\pyenv-win\shims\python.bat "%~dp0supervisor.py"
pause
