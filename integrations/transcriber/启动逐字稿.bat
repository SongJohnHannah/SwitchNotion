@echo off
chcp 65001 >nul
echo ==================================================
echo   Transcriber - http://localhost:3066
echo ==================================================
echo.
if not defined TRANSCRIBER_PYTHON set "TRANSCRIBER_PYTHON=C:\Users\songf\.pyenv\pyenv-win\versions\3.12.0\python.exe"
if not exist "%TRANSCRIBER_PYTHON%" (
  echo Python not found. Set TRANSCRIBER_PYTHON to the Python with Flask and waitress.
  pause
  exit /b 1
)
"%TRANSCRIBER_PYTHON%" -X utf8 "%~dp0supervisor.py"
pause
