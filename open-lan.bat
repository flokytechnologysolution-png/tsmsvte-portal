@echo off
REM ===========================================================================
REM  open-lan.bat - let the TSMSVTE portal be opened from your phone, tablet
REM  or another computer on the SAME Wi-Fi / network.
REM
REM  This adds a Windows Firewall rule for TCP port 3000. It asks for
REM  administrator permission once. To undo it, run the same file again.
REM ===========================================================================
setlocal
set RULE=TSMSVTE Portal (3000)

REM Already an admin? If not, re-launch this file elevated.
net session >nul 2>&1
if not "%errorlevel%"=="0" (
    echo Requesting administrator permission - please click "Yes"...
    powershell -NoProfile -ExecutionPolicy Bypass -Command ^
        "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

echo.
echo  Opening the portal on your local network...
echo.
netsh advfirewall firewall delete rule name="%RULE%" >nul 2>&1
netsh advfirewall firewall add rule name="%RULE%" dir=in action=allow ^
    protocol=TCP localport=3000 profile=private >nul 2>&1

if not "%errorlevel%"=="0" (
    echo  FAILED. Please right-click this file and choose
    echo  "Run as administrator", then try again.
    pause
    exit /b 1
)

REM Work out the address to open on the other device.
for /f "tokens=3" %%i in ('powershell -NoProfile -Command ^
    "(Get-NetIPAddress -AddressFamily IPv4 ^| Where-Object { $_.IPAddress -notlike '127.*' -and $_.InterfaceAlias -notmatch 'Loopback' } ^| Select-Object -First 1 -ExpandProperty IPAddress)"') do set LANIP=%%i

echo  DONE. The firewall now allows the portal on this network.
echo.
echo  On your phone, tablet or another computer, open:
echo.
if defined LANIP (
    echo        http://%LANIP%:3000
) else (
    echo        http://YOUR-COMPUTERS-IP:3000
)
echo.
echo  The two devices must be on the SAME Wi-Fi network.
echo.
echo  Note: if your router gives this computer a new IP address later,
echo  the address above will change - run this file again to see the new one.
echo.
echo  To remove the rule later, run this file again.
echo.
pause
endlocal