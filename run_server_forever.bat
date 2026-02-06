@echo off
title ZK Attendance Server - Auto Restart
cls
echo ====================================================
echo   ZK Attendance Auto-Sync Server
echo   Running in infinite loop (Auto-Restart enabled)
echo ====================================================

:loop
echo.
echo [%DATE% %TIME%] Starting server...
node server.js
echo.
echo [%DATE% %TIME%] Server stopped! Restarting in 5 seconds...
timeout /t 5 >nul
goto loop
