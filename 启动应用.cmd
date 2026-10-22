@echo off
chcp 65001 >nul
cd /d "%~dp0"
where python >nul 2>&1
if errorlevel 1 (
  echo 请先安装 Python 3，再重新打开此文件。
  echo 安装地址：https://www.python.org/downloads/
  pause
  exit /b 1
)
python "%~dp0tools\serve.py"
if errorlevel 1 pause
