@echo off
title Infinite Canvas Server
cd /d %~dp0
echo Starting Infinite Canvas ...
node server\server.mjs
pause
