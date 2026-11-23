# התקנה מלאה של שרת העובדים ב-Windows. אפשר להריץ שוב ושוב (מדלג על מה שכבר מותקן).
# מה זה עושה: Node.js, ffmpeg, whisper.cpp + מודל שטוב בעברית, GitHub CLI ו-Vercel CLI, תוסף HyperFrames ל-Claude Code,
#             npm install, ומשימה מתוזמנת שמפעילה את השרת בכל כניסה למחשב ומקימה אותו מחדש אם נפל.
# שימוש:   powershell -ExecutionPolicy Bypass -File install.ps1
# אפשרויות: -Lang he|auto|en (שפת תמלול, ברירת מחדל he)  -SkipWhisper  -SkipTools (בלי gh/vercel)  -SkipPlugins  -Remove
# חשוב: השרת רץ על מחשב אחד בלבד. לפני התקנה במחשב אחר, להריץ במחשב הקודם  install.ps1 -Remove
param(
  [switch]$Remove,
  [string]$Lang = 'he',
  [switch]$SkipWhisper,
  [switch]$SkipTools,
  [switch]$SkipPlugins
)
$name = 'AI WhatsApp Workers'
$dir = $PSScriptRoot
$port = 3100
$results = [ordered]@{}
function Ok($k, $v) { $results[$k] = "✓ $v" }
function Bad($k, $v) { $results[$k] = "✗ $v" }
function Has($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
function RefreshPath { $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') }
function WingetInstall($id, $label) {
  if (-not (Has 'winget')) { Write-Host "אין winget במחשב. להתקין $label ידנית."; return $false }
  Write-Host "מתקין $label..."
  winget install --id $id -e --accept-source-agreements --accept-package-agreements --silent | Out-Host
  RefreshPath
  return $true
}

if (Test-Path "$dir\workers.json") {
  $cfg = Get-Content "$dir\workers.json" -Raw -Encoding utf8 | ConvertFrom-Json
  if ($cfg.port) { $port = [int]$cfg.port }
}

# ---------- לעצור מופע קיים במחשב הזה ----------
# רק לולאת run.ps1 של התיקייה הזאת, ורק התהליך שמחזיק את הפורט. שום תהליך node אחר.
Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
  Where-Object { $_.CommandLine -like "*$dir\run.ps1*" -and $_.ProcessId -ne $PID } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2

if ($Remove) {
  Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
  Remove-Item "$dir\running-on.txt" -ErrorAction SilentlyContinue
  Write-Host "הוסר מהמחשב הזה ($env:COMPUTERNAME)."
  exit
}

# ---------- 1. Node.js ----------
$nodeOk = $false
if (Has 'node') { $major = [int]((node -p "process.versions.node.split('.')[0]") | Out-String).Trim(); $nodeOk = $major -ge 20 }
if (-not $nodeOk) { WingetInstall 'OpenJS.NodeJS.LTS' 'Node.js LTS' | Out-Null }
if (Has 'node') { Ok 'Node.js' (node --version) } else { Bad 'Node.js' 'לא הותקן. להתקין מ-nodejs.org (LTS) ולהריץ שוב'; $results.GetEnumerator() | ForEach-Object { Write-Host "$($_.Key): $($_.Value)" }; Read-Host 'Enter לסגירה'; exit 1 }

# ---------- 2. ffmpeg + whisper.cpp + מודל ----------
if ($SkipWhisper) {
  if (-not (Has 'ffmpeg')) { WingetInstall 'Gyan.FFmpeg' 'ffmpeg' | Out-Null }
  $results['תמלול'] = '- דילגנו (-SkipWhisper)'
} else {
  try { & "$dir\install-whisper.ps1"; RefreshPath; Ok 'תמלול' "whisper.cpp + מודל large-v3-turbo, שפה: $Lang" }
  catch { Bad 'תמלול' $_.Exception.Message }
}
$ffLink = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\ffmpeg.exe'
if ((Has 'ffmpeg') -or (Test-Path $ffLink)) { Ok 'ffmpeg' 'מותקן' } else { Bad 'ffmpeg' 'לא נמצא. winget install Gyan.FFmpeg' }

# ---------- 3. GitHub CLI + Vercel CLI (לחיבור בתהליך ההתחלה) ----------
if (-not $SkipTools) {
  if (-not (Has 'gh')) { WingetInstall 'GitHub.cli' 'GitHub CLI' | Out-Null }
  if (Has 'gh') { Ok 'GitHub CLI' 'מותקן (החיבור נעשה מהווצאפ, בתהליך ההתחלה)' } else { Bad 'GitHub CLI' 'לא הותקן. winget install GitHub.cli' }
  if (-not (Has 'vercel')) { Write-Host 'מתקין Vercel CLI...'; npm install -g vercel --no-audit --no-fund | Out-Host; RefreshPath }
  if (Has 'vercel') { Ok 'Vercel CLI' 'מותקן' } else { Bad 'Vercel CLI' 'לא הותקן. npm i -g vercel' }
}

# ---------- 4. Claude Code + תוסף HyperFrames ----------
if (Has 'claude') {
  Ok 'Claude Code' ((claude --version) | Out-String).Trim()
  if (-not $SkipPlugins) {
    $plugins = (claude plugin list) -join "`n"
    if ($plugins -match 'hyperframes@hyperframes') { Ok 'HyperFrames' 'כבר מותקן' }
    else {
      $markets = (claude plugin marketplace list) -join "`n"
      if ($markets -notmatch 'heygen-com/hyperframes') { claude plugin marketplace add heygen-com/hyperframes | Out-Host }
      claude plugin install hyperframes@hyperframes --scope user | Out-Host
      $plugins = (claude plugin list) -join "`n"
      if ($plugins -match 'hyperframes@hyperframes') { Ok 'HyperFrames' 'הותקן' } else { Bad 'HyperFrames' 'ההתקנה נכשלה. להריץ ידנית: claude plugin marketplace add heygen-com/hyperframes ואז claude plugin install hyperframes@hyperframes' }
    }
  }
} else {
  Bad 'Claude Code' 'לא נמצא. להתקין (irm https://claude.ai/install.ps1 | iex), להריץ claude פעם אחת ולהתחבר, ואז להריץ שוב את הסקריפט'
}

# ---------- 5. חבילות השרת ----------
Push-Location $dir
Write-Host 'מתקין חבילות של השרת...'
npm install --no-audit --no-fund | Out-Host
$npmOk = $LASTEXITCODE -eq 0
Pop-Location
if ($npmOk) { Ok 'חבילות' 'npm install הצליח' } else { Bad 'חבילות' 'npm install נכשל, לבדוק את הפלט למעלה' }

# ---------- 6. הגדרות + הפעלה אוטומטית ----------
if (-not (Test-Path "$dir\workers.json")) {
  Bad 'workers.json' 'חסר. להעתיק את workers.example.json לכאן בשם workers.json, למלא, ולהריץ שוב את הסקריפט'
} else {
  # שפת התמלול נכתבת דרך node (ConvertTo-Json של PowerShell 5 מקצץ אובייקטים עמוקים)
  $env:AIW_LANG = $Lang
  node -e "const fs=require('fs');const f=process.argv[1];const c=JSON.parse(fs.readFileSync(f,'utf8').replace(/^﻿/,''));c.whisper=c.whisper||{};if(c.whisper.lang!==process.env.AIW_LANG){c.whisper.lang=process.env.AIW_LANG;fs.writeFileSync(f,JSON.stringify(c,null,2))}" "$dir\workers.json"
  Ok 'workers.json' "קיים (שפת תמלול: $Lang)"

  # תופס את השרת: כותב את שם המחשב הזה. אם התיקייה מסונכרנת, המחשב השני רואה את זה ומשחרר לבד.
  $owner = if (Test-Path "$dir\running-on.txt") { (Get-Content "$dir\running-on.txt" -Raw).Trim() } else { '' }
  Set-Content -Path "$dir\running-on.txt" -Value $env:COMPUTERNAME -NoNewline -Encoding ascii
  if ($owner -and $owner -ne $env:COMPUTERNAME) {
    Write-Host "השרת רץ כרגע על $owner. מחכה דקה שהוא ישתחרר שם..."
    Start-Sleep -Seconds 60
  }

  $action  = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$dir\run.ps1`"" -WorkingDirectory $dir
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $set     = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $set -Force | Out-Null
  Start-ScheduledTask -TaskName $name
  Ok 'הפעלה אוטומטית' "משימה מתוזמנת '$name' רצה על $env:COMPUTERNAME"
}

# ---------- סיכום ----------
Write-Host ''
Write-Host '===== סיכום ההתקנה ====='
$results.GetEnumerator() | ForEach-Object { Write-Host "$($_.Key): $($_.Value)" }
Write-Host ''
Write-Host "סטטוס וחיבור מספרים: http://localhost:$port"
Write-Host 'כדי שהמחשב לא יירדם: הגדרות > מערכת > צריכת חשמל > שינה: אף פעם (כשמחובר לחשמל).'
Write-Host 'אחרי שהעובד מחובר: לכתוב לו בווצאפ "התחלה" לבדיקה עצמית וחיבור מערכות.'
