@echo off
rem Start Chrome on the discrete GPU for demos/kiosks/testing on Windows hybrid laptops.
rem A web page cannot pick the GPU itself; this launcher (or Windows Settings > System > Display >
rem Graphics > Chrome > "High performance") can. Uses a separate profile so flags apply reliably.
rem Usage: start-chrome-dgpu.cmd http://localhost:5173/
set URL=%~1
if "%URL%"=="" set URL=http://localhost:5173/
set CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe
if not exist "%CHROME%" set CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe
if not exist "%CHROME%" set CHROME=%LocalAppData%\Google\Chrome\Application\chrome.exe
start "" "%CHROME%" --user-data-dir="%LocalAppData%\chrome-dgpu-profile" --new-window ^
  --force_high_performance_gpu --use-angle=d3d11 --ignore-gpu-blocklist --enable-gpu-rasterization ^
  "%URL%"
rem For the integrated GPU instead: replace --force_high_performance_gpu with --force_low_power_gpu
