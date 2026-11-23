#!/usr/bin/env bash
# התקנה מלאה של שרת העובדים ב-Mac. אפשר להריץ שוב ושוב (מדלג על מה שכבר מותקן).
# מה זה עושה: Homebrew, Node.js, ffmpeg, whisper.cpp + מודל שטוב בעברית, GitHub CLI ו-Vercel CLI,
#             תוסף HyperFrames ל-Claude Code, npm install, LaunchAgent שמפעיל את השרת בכל כניסה ומקים אותו אם נפל,
#             והוראות מדויקות ל-Full Disk Access לקובץ ה-node שבאמת מריץ את השרת.
# שימוש:     bash install-mac.sh
# אפשרויות:  --lang he|auto|en (שפת תמלול, ברירת מחדל he)  --skip-whisper  --skip-tools  --skip-plugins  --remove
set -euo pipefail

LANG_CODE="he"; SKIP_WHISPER=0; SKIP_TOOLS=0; SKIP_PLUGINS=0; REMOVE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --lang) LANG_CODE="${2:?חסר ערך ל--lang}"; shift 2 ;;
    --skip-whisper) SKIP_WHISPER=1; shift ;;
    --skip-tools) SKIP_TOOLS=1; shift ;;
    --skip-plugins) SKIP_PLUGINS=1; shift ;;
    --remove) REMOVE=1; shift ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) echo "אפשרות לא מוכרת: $1"; exit 2 ;;
  esac
done

if [[ "$(uname -s)" != "Darwin" ]]; then echo "הסקריפט הזה ל-Mac בלבד. ב-Windows: server/install.ps1"; exit 1; fi

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER="$DIR/server"
LABEL="com.ai-whatsapp-workers.server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
GUI="gui/$(id -u)"
MODEL_DIR="$HOME/tools/whisper/models"
MODEL="$MODEL_DIR/ggml-large-v3-turbo-q5_0.bin"
MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin"

SUMMARY=()
ok()  { SUMMARY+=("✓ $1: $2"); }
bad() { SUMMARY+=("✗ $1: $2"); }
skip() { SUMMARY+=("- $1: $2"); }
has() { command -v "$1" >/dev/null 2>&1; }
real() { # נתיב אמיתי אחרי פתיחת קיצורים (symlinks)
  if has realpath; then realpath "$1"; else perl -MCwd -e 'print Cwd::abs_path(shift)' "$1"; fi
}
print_summary() {
  echo; echo "===== סיכום ההתקנה ====="
  local s; for s in "${SUMMARY[@]}"; do echo "$s"; done
}

PORT=3100
if [[ -f "$SERVER/workers.json" ]] && has node; then
  PORT="$(node -e 'try{const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8").replace(/^﻿/,""));console.log(c.port||3100)}catch{console.log(3100)}' "$SERVER/workers.json")"
fi

# ---------- לעצור מופע קיים במחשב הזה (רק שלנו: ה-LaunchAgent והתהליך שמחזיק את הפורט) ----------
launchctl bootout "$GUI/$LABEL" >/dev/null 2>&1 || true
if has lsof; then
  for pid in $(lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null || true); do kill "$pid" 2>/dev/null || true; done
fi
sleep 1

if [[ $REMOVE -eq 1 ]]; then
  rm -f "$PLIST" "$SERVER/running-on.txt"
  echo "הוסר מהמחשב הזה ($(hostname))."
  exit 0
fi

# ---------- 1. Homebrew ----------
if ! has brew; then
  for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do [[ -x "$b" ]] && eval "$("$b" shellenv)" && break; done
fi
if ! has brew; then
  echo "מתקין Homebrew (יבקש את סיסמת המחשב)..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do [[ -x "$b" ]] && eval "$("$b" shellenv)" && break; done
fi
if has brew; then ok "Homebrew" "$(brew --version | head -1)"; else bad "Homebrew" "לא הותקן. להתקין מ-brew.sh ולהריץ שוב"; print_summary; exit 1; fi
BREW_PREFIX="$(brew --prefix)"

# ---------- 2. Node.js (20 ומעלה) ----------
NODE_MAJOR=0
if has node; then NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"; fi
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  echo "מתקין Node.js..."
  brew install node
  hash -r
fi
if ! has node; then bad "Node.js" "לא הותקן"; print_summary; exit 1; fi
NODE_BIN="$(command -v node)"
if [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]]; then echo "אזהרה: ב-PATH יש node ישן מ-20 (אולי nvm). השרת ישתמש בו, וזה עלול לא לעבוד."; fi
NODE_REAL="$(real "$NODE_BIN")"
ok "Node.js" "$(node --version) ($NODE_REAL)"

# ---------- 3. ffmpeg + whisper.cpp + מודל ----------
if ! has ffmpeg; then echo "מתקין ffmpeg..."; brew install ffmpeg; fi
if has ffmpeg; then ok "ffmpeg" "$(ffmpeg -version | head -1 | cut -d' ' -f1-3)"; else bad "ffmpeg" "לא הותקן. brew install ffmpeg"; fi

if [[ $SKIP_WHISPER -eq 1 ]]; then
  skip "תמלול" "דילגנו (--skip-whisper)"
else
  if ! has whisper-cli && ! has whisper-cpp; then echo "מתקין whisper.cpp..."; brew install whisper-cpp; fi
  mkdir -p "$MODEL_DIR"
  MODEL_SIZE=0
  [[ -f "$MODEL" ]] && MODEL_SIZE="$(stat -f %z "$MODEL")"
  if [[ "$MODEL_SIZE" -lt 400000000 ]]; then
    echo "מוריד מודל תמלול (כ-550MB, כמה דקות)..."
    curl -fL --retry 3 -C - -o "$MODEL" "$MODEL_URL"
  fi
  if has whisper-cli; then
    ok "תמלול" "whisper.cpp + מודל large-v3-turbo, שפה: $LANG_CODE"
  elif has whisper-cpp; then
    # גרסאות ישנות של הנוסחה קראו לקובץ whisper-cpp. השרת מחפש whisper-cli, אז מגדירים נתיב מפורש.
    WHISPER_EXE="$(command -v whisper-cpp)"
    ok "תמלול" "whisper.cpp (whisper-cpp) + מודל, שפה: $LANG_CODE"
  else
    bad "תמלול" "whisper.cpp לא נמצא. brew install whisper-cpp"
  fi
fi

# ---------- 4. GitHub CLI + Vercel CLI ----------
if [[ $SKIP_TOOLS -eq 0 ]]; then
  has gh || { echo "מתקין GitHub CLI..."; brew install gh; }
  if has gh; then ok "GitHub CLI" "מותקן (החיבור נעשה מהווצאפ, בתהליך ההתחלה)"; else bad "GitHub CLI" "brew install gh"; fi
  has vercel || { echo "מתקין Vercel CLI..."; npm install -g vercel --no-audit --no-fund; hash -r; }
  if has vercel; then ok "Vercel CLI" "מותקן"; else bad "Vercel CLI" "npm i -g vercel"; fi
fi

# ---------- 5. Claude Code + תוסף HyperFrames ----------
if has claude; then
  ok "Claude Code" "$(claude --version 2>/dev/null | head -1)"
  if [[ $SKIP_PLUGINS -eq 0 ]]; then
    PLUGINS="$(claude plugin list 2>/dev/null || true)"
    if [[ "$PLUGINS" == *"hyperframes@hyperframes"* ]]; then
      ok "HyperFrames" "כבר מותקן"
    else
      MARKETS="$(claude plugin marketplace list 2>/dev/null || true)"
      [[ "$MARKETS" == *"heygen-com/hyperframes"* ]] || claude plugin marketplace add heygen-com/hyperframes || true
      claude plugin install hyperframes@hyperframes --scope user || true
      PLUGINS="$(claude plugin list 2>/dev/null || true)"
      if [[ "$PLUGINS" == *"hyperframes@hyperframes"* ]]; then ok "HyperFrames" "הותקן"
      else bad "HyperFrames" "נכשל. ידנית: claude plugin marketplace add heygen-com/hyperframes ואז claude plugin install hyperframes@hyperframes"; fi
    fi
  fi
else
  bad "Claude Code" "לא נמצא. להתקין (curl -fsSL https://claude.ai/install.sh | bash), להריץ claude פעם אחת ולהתחבר, ואז להריץ שוב את הסקריפט"
fi

# ---------- 6. חבילות השרת ----------
echo "מתקין חבילות של השרת..."
if (cd "$SERVER" && npm install --no-audit --no-fund); then ok "חבילות" "npm install הצליח"; else bad "חבילות" "npm install נכשל, לבדוק את הפלט למעלה"; fi

# ---------- 7. הגדרות + LaunchAgent ----------
if [[ ! -f "$SERVER/workers.json" ]]; then
  bad "workers.json" "חסר. להעתיק את workers.example.json ל-server/workers.json, למלא, ולהריץ שוב את הסקריפט"
else
  # שפת התמלול (ונתיב whisper אם הקובץ נקרא whisper-cpp)
  AIW_LANG="$LANG_CODE" AIW_WHISPER_EXE="${WHISPER_EXE:-}" node -e '
    const fs = require("fs"); const f = process.argv[1]
    const c = JSON.parse(fs.readFileSync(f, "utf8").replace(/^﻿/, "")); c.whisper = c.whisper || {}
    let changed = false
    if (c.whisper.lang !== process.env.AIW_LANG) { c.whisper.lang = process.env.AIW_LANG; changed = true }
    if (process.env.AIW_WHISPER_EXE && !c.whisper.exe) { c.whisper.exe = process.env.AIW_WHISPER_EXE; changed = true }
    if (changed) fs.writeFileSync(f, JSON.stringify(c, null, 2))' "$SERVER/workers.json"
  ok "workers.json" "קיים (שפת תמלול: $LANG_CODE)"

  # מחשב אחד בכל רגע: לתפוס את השרת. אם התיקייה מסונכרנת, המחשב השני משחרר לבד.
  HOST="$(hostname)"
  OWNER=""; [[ -f "$SERVER/running-on.txt" ]] && OWNER="$(tr -d '[:space:]' < "$SERVER/running-on.txt")"
  printf '%s' "$HOST" > "$SERVER/running-on.txt"
  if [[ -n "$OWNER" ]] && [[ "$(echo "$OWNER" | tr '[:lower:]' '[:upper:]')" != "$(echo "$HOST" | tr '[:lower:]' '[:upper:]')" ]]; then
    echo "השרת רץ כרגע על $OWNER. מחכה דקה שהוא ישתחרר שם..."
    sleep 60
  fi

  # PATH מלא בשביל launchd (שם ה-PATH מינימלי): brew, node, ו-claude שמותקן ב-~/.local/bin
  RUN_PATH="$(dirname "$NODE_REAL"):$(dirname "$NODE_BIN"):$BREW_PREFIX/bin:$BREW_PREFIX/sbin:$HOME/.local/bin:$HOME/.claude/local:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml "$NODE_REAL")</string>
    <string>$(xml "$SERVER/supervise.mjs")</string>
  </array>
  <key>WorkingDirectory</key><string>$(xml "$SERVER")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(xml "$RUN_PATH")</string>
    <key>HOME</key><string>$(xml "$HOME")</string>
    <key>LANG</key><string>en_US.UTF-8</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$(xml "$SERVER/launchd.log")</string>
  <key>StandardErrorPath</key><string>$(xml "$SERVER/launchd.log")</string>
</dict>
</plist>
PLIST_EOF
  plutil -lint "$PLIST" >/dev/null
  # bootout מהשלב הקודם לפעמים עוד לא הסתיים: ניסיון חוזר אחד
  launchctl bootstrap "$GUI" "$PLIST" 2>/dev/null || { sleep 3; launchctl bootout "$GUI/$LABEL" >/dev/null 2>&1 || true; sleep 1; launchctl bootstrap "$GUI" "$PLIST"; }
  launchctl enable "$GUI/$LABEL" || true
  launchctl kickstart -k "$GUI/$LABEL" || true
  ok "הפעלה אוטומטית" "LaunchAgent $LABEL (עולה בכל כניסה, קם לבד אם נפל)"
fi

print_summary

# ---------- Full Disk Access ----------
printf '%s' "$NODE_REAL" | pbcopy 2>/dev/null || true
cat <<EOF

===== חשוב: Full Disk Access (גישה מלאה לדיסק) =====
בלי זה העובד לא יוכל לקרוא קבצים בשולחן העבודה, במסמכים, בהורדות ובדיסקים חיצוניים, ו-macOS יחסום אותו בשקט.
ההרשאה צריכה להינתן לקובץ ה-node שמריץ את השרת. לא ל-Terminal (זה רק כשמריצים ידנית מהטרמינל).

הקובץ שצריך לאשר:
  $NODE_REAL

1. עכשיו ייפתח חלון: הגדרות המערכת > פרטיות ואבטחה > גישה מלאה לדיסק.
2. ללחוץ על + בתחתית הרשימה (יבקש סיסמה או טביעת אצבע).
3. בחלון בחירת הקובץ ללחוץ Cmd+Shift+G, להדביק את הנתיב שלמעלה (הוא כבר הועתק ללוח), Enter, ואז "פתח".
4. לוודא שהמתג ליד node דולק.
5. להפעיל מחדש את השרת:  launchctl kickstart -k $GUI/$LABEL

שימו לב: אחרי עדכון של node (brew upgrade) הנתיב משתנה וההרשאה הולכת לאיבוד.
אז מריצים שוב את הסקריפט הזה ומאשרים את הנתיב החדש. כדי למנוע עדכונים מפתיעים:  brew pin node

===== שהמחשב לא יירדם =====
השרת מפעיל caffeinate בזמן שהוא רץ, וזה מונע שינה כשהמחשב מחובר לחשמל. בנוסף, מומלץ:
1. הגדרות המערכת > סוללה (או חיסכון באנרגיה) > אפשרויות: להדליק "מנע שינה אוטומטית כשהצג כבוי" (על חשמל).
2. או בטרמינל:  sudo pmset -c sleep 0 disksleep 0 womp 1
3. אחרי הפסקת חשמל, לעלות לבד:  sudo pmset -a autorestart 1
4. מחשב נייד עם מכסה סגור נרדם, אלא אם מחובר למסך חיצוני ולחשמל.

סטטוס וחיבור מספרים: http://localhost:$PORT
אחרי שהעובד מחובר: לכתוב לו בווצאפ "התחלה" לבדיקה עצמית וחיבור מערכות.
EOF

open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles" 2>/dev/null || true
