@echo off
setlocal
set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not exist "%NODE%" set "NODE=node"
"%NODE%" "%~dp0..\src\dafeiyutuo.mjs" %*
