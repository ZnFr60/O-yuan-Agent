@echo off
REM ============================================
REM install-conclave-service.bat - 安装 Conclave 开机自启动 (Windows)
REM 用法: 右键以管理员身份运行
REM ============================================
setlocal
set CONCLAVE_DIR=D:\DeepseekH\conclave
set TASK_NAME=ConclaveAgent

REM 创建启动器脚本 (隐藏窗口运行)
set LAUNCHER=%CONCLAVE_DIR%\start-conclave-hidden.vbs
echo Set WshShell = CreateObject("WScript.Shell") > "%LAUNCHER%"
echo WshShell.CurrentDirectory = "%CONCLAVE_DIR%" >> "%LAUNCHER%"
echo WshShell.Run "cmd /c node src\js\server.js >> logs\server.log 2>&1", 0, False >> "%LAUNCHER%"

REM 注册任务计划程序 (开机时以SYSTEM运行)
schtasks /Create /F /TN "%TASK_NAME%" /TR "wscript.exe \"%LAUNCHER%\"" /SC ONSTART /RU SYSTEM /RL HIGHEST
if %errorlevel%==0 (
  echo [OK] 已注册开机自启动任务: %TASK_NAME%
) else (
  echo [FAIL] 注册失败，请以管理员身份运行
)

REM 立即启动一次
start "" wscript.exe "%LAUNCHER%"
echo [OK] Conclave 已启动 (后台运行)
endlocal