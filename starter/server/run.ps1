# מריץ את שרת העובדים ומקים אותו מחדש אם נפל. אפשר להריץ ידנית, או דרך המשימה המתוזמנת ש-install.ps1 יוצר.
$ErrorActionPreference = 'Continue'
Set-Location $PSScriptRoot
while ($true) {
  Add-Content -Encoding utf8 server.log "===== $(Get-Date -Format s) הפעלה ב-$env:COMPUTERNAME"
  cmd /c "node index.js >> server.log 2>&1"
  $code = $LASTEXITCODE
  Add-Content -Encoding utf8 server.log "===== $(Get-Date -Format s) השרת נעצר (קוד $code), עולה מחדש בעוד 10 שניות"
  # קוד 4 = מחשב אחר מחזיק את החיבור. קוד 3 = העובדים עברו למחשב אחר. לא לחזור. (קוד 0 = workers.json השתנה, קוד 1 = קרס: כן לחזור)
  if ($code -eq 3 -or $code -eq 4) { Add-Content -Encoding utf8 server.log "השרת רץ במחשב אחר. הלולאה כאן נעצרת."; break }
  Start-Sleep -Seconds 10
}
