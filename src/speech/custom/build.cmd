@echo off
setlocal
set "ROOT=%~dp0"
set "TEMP=%ROOT%build-tmp"
set "TMP=%TEMP%"
if not exist "%TEMP%" mkdir "%TEMP%"
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
if errorlevel 1 exit /b %errorlevel%
set "NVCC=C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v13.3\bin\nvcc.exe"
for %%F in ("%ROOT%ops\*.cu") do (
  echo Building %%~nF
  "%NVCC%" --cubin --fmad=false -lineinfo -arch=sm_75 -std=c++17 -Xptxas=-v -Xcompiler=/wd4819 "%%~fF" -o "%ROOT%ops\%%~nF.cubin"
  if errorlevel 1 exit /b %errorlevel%
)
exit /b 0
