@echo off
REM ==========================================================================
REM  Taraba State Ministry of Secondary, Vocational and Technical Education
REM  Portal launcher (Windows).  Double-click this file.
REM ==========================================================================
setlocal
cd /d "%~dp0"

echo(
echo  ============================================================
echo   TARABA STATE MINISTRY OF SECONDARY, VOCATIONAL
echo   AND TECHNICAL EDUCATION - PORTAL
echo  ============================================================
echo(

if not exist "node_modules" (
  echo  [1/2] First run detected - installing dependencies...
  echo        (this can take a few minutes on a slow connection)
  call npm install
  if errorlevel 1 (
    echo(
    echo  ERROR: npm install failed. Check your internet connection and try again.
    pause
    exit /b 1
  )
)

if not exist ".env" (
  echo  [2/2] No .env found - creating one from .env.example
  copy /y ".env.example" ".env" >nul
  echo        IMPORTANT: open .env and change JWT_SECRET, OWNER_EMAIL
  echo        and OWNER_PASSWORD before going live.
  echo(
)

echo  Starting portal on http://localhost:3000
echo  Press CTRL+C to stop.
echo(
node server.js

echo(
echo  Server stopped.
pause
endlocal