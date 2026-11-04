# התקנת שרת העובדים כמשימה מתוזמנת ב-Windows: עולה בכל כניסה למחשב ומתאושש לבד אם נפל.
# שימוש: לחיצה ימנית > Run with PowerShell.   להסרה: install.ps1 -Remove
# חשוב: השרת רץ על מחשב אחד בלבד. לפני התקנה במחשב אחר, להריץ במחשב הקודם  install.ps1 -Remove
param([switch]$Remove)
$name = 'AI WhatsApp Workers'
$dir = $PSScriptRoot
$port = 3100
if (Test-Path "$dir\workers.json") {
  $cfg = Get-Content "$dir\workers.json" -Raw -Encoding utf8 | ConvertFrom-Json
  if ($cfg.port) { $port = [int]$cfg.port }
}

# לעצור מופע קיים במחשב הזה: רק לולאת run.ps1 של התיקייה הזאת, ורק התהליך שמחזיק את הפורט. שום תהליך node אחר.
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

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Host "חסר Node.js במחשב הזה. להתקין מ-nodejs.org (LTS) ולהריץ שוב."; Read-Host "Enter לסגירה"; exit 1 }
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) { Write-Host "אזהרה: Claude Code לא נמצא במחשב הזה. העובדים יתחברו לווצאפ אבל לא יוכלו לחשוב." }
if (-not (Test-Path "$dir\workers.json")) { Write-Host "חסר workers.json. להעתיק את workers.example.json לכאן בשם workers.json ולמלא."; Read-Host "Enter לסגירה"; exit 1 }
if (-not (Test-Path "$dir\node_modules")) { Write-Host "מתקין חבילות (פעם ראשונה, כדקה)..."; Push-Location $dir; npm install --no-audit --no-fund; Pop-Location }

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
Write-Host "הותקן ורץ על $env:COMPUTERNAME. סטטוס: http://localhost:$port"
