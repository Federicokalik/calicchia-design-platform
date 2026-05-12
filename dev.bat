@echo off
title Caldes 2026 - Development Server

echo ========================================
echo   Caldes 2026 - Development Server
echo ========================================
echo.
echo API (Hono):          http://localhost:3001
echo Sito v3 (Next.js):   http://localhost:3000
echo Admin (React):       http://localhost:5173
echo.
echo Avvio in corso...
echo.

start "API" cmd /c "cd apps\api && npm run dev"
start "Sito v3" cmd /c "cd apps\sito-v3 && npm run dev"
start "Admin" cmd /c "cd apps\admin && npm run dev"

echo Tutti i server avviati in finestre separate.
echo Chiudi questa finestra per info, i server restano attivi.
pause
