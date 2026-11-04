# התקנת תמלול קולי מקומי (whisper.cpp + מודל + ffmpeg) ב-Windows, בשביל הודעות קוליות לעובדים.
# שימוש: powershell -ExecutionPolicy Bypass -File install-whisper.ps1
# מתקין ל: %USERPROFILE%\tools\whisper\Release + \models  (אלה ברירות המחדל של transcribe.js)
# Mac: brew install whisper-cpp ffmpeg, ולהוריד את המודל ידנית (הקישור למטה) ולהגדיר whisper.model ב-workers.json
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # הורדות מהירות יותר
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$root = Join-Path $env:USERPROFILE 'tools\whisper'
$rel = Join-Path $root 'Release'
$models = Join-Path $root 'models'
New-Item -ItemType Directory -Force $rel, $models | Out-Null

# 1. whisper.cpp
if (Test-Path "$rel\whisper-cli.exe") { Write-Host "whisper.cpp כבר מותקן." }
else {
  Write-Host "מוריד whisper.cpp..."
  $r = Invoke-RestMethod 'https://api.github.com/repos/ggml-org/whisper.cpp/releases/latest' -Headers @{ 'User-Agent' = 'ai-whatsapp-workers' }
  $asset = $r.assets | Where-Object { $_.name -eq 'whisper-bin-x64.zip' } | Select-Object -First 1
  if (-not $asset) { throw "לא נמצא whisper-bin-x64.zip בגרסה $($r.tag_name)" }
  $zip = Join-Path $env:TEMP 'whisper-bin-x64.zip'
  Invoke-WebRequest $asset.browser_download_url -OutFile $zip
  $x = Join-Path $env:TEMP 'whisper-x'
  Remove-Item $x -Recurse -Force -ErrorAction SilentlyContinue
  Expand-Archive $zip $x -Force
  $cli = Get-ChildItem $x -Recurse -Filter 'whisper-cli.exe' | Select-Object -First 1
  Copy-Item (Join-Path $cli.DirectoryName '*') $rel -Recurse -Force
  Write-Host "whisper.cpp $($r.tag_name) הותקן."
}

# 2. מודל (large-v3-turbo מכווץ, כ-550MB, טוב בעברית ומהיר יחסית על מעבד)
$model = Join-Path $models 'ggml-large-v3-turbo-q5_0.bin'
if ((Test-Path $model) -and ((Get-Item $model).Length -gt 400MB)) { Write-Host "המודל כבר קיים." }
else {
  Write-Host "מוריד מודל (כ-550MB, כמה דקות)..."
  Invoke-WebRequest 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin' -OutFile $model
  Write-Host "המודל ירד."
}

# 3. ffmpeg
if (Get-Command ffmpeg -ErrorAction SilentlyContinue) { Write-Host "ffmpeg כבר מותקן." }
else {
  Write-Host "מתקין ffmpeg..."
  winget install --id Gyan.FFmpeg -e --accept-source-agreements --accept-package-agreements --silent
  Write-Host "ffmpeg הותקן. אם השרת כבר רץ, להפעיל אותו מחדש כדי שיכיר אותו."
}

# 4. בדיקה
& "$rel\whisper-cli.exe" --help *> $null
if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 1) { throw "whisper-cli לא רץ (קוד $LASTEXITCODE)" }
Write-Host ""
Write-Host "התמלול מוכן."
