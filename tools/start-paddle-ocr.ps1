$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$python = Join-Path $projectRoot ".paddle-ocr-runtime\Scripts\python.exe"
$server = Join-Path $PSScriptRoot "paddle_ocr_server.py"
$logDir = Join-Path $projectRoot ".paddle-ocr-logs"

if (-not (Test-Path -LiteralPath $python)) {
  throw "未找到 PP-OCR 运行环境：$python"
}

New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$env:PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK = "True"
& $python $server
