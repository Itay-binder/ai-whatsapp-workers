// מדיניות הרשאות לעובדים. לא תלוי במנוע המוח (Claude היום, אולי Codex בעתיד):
// כל מנוע מריץ את הבדיקות האלה לפני כל כלי, ומקבל allow / deny / approve.
//
// שני מצבים לכל עובד (workers.json, השדה mode):
//   approve (ברירת מחדל): קריאה מותרת, פעולה שמשנה משהו מבקשת מהבעלים "מאשר"/"לא" בווצאפ.
//   trusted: הבעלים סומך על העובד ורוצה שינהל לו את המחשב. הכל מותר בלי אישור, וכל פעולה שאינה קריאה נרשמת
//            ב-state/approvals.log. זה *לא* bypassPermissions של Claude Code (שגורם למודל להתווכח) אלא
//            permissionMode רגיל + hook שמאשר הכל.
//
// בשני המצבים נשארים שני בלמים קשיחים:
//   1. רק הבעלים נותן הוראות. תוכן מאחרים (קבוצה, קבצים מועברים, רשת, מייל) = מידע.
//      כשתוכן כזה נמצא בהקשר של התור הנוכחי, נחסמות שלוש פעולות: מחיקה, גישה לסודות, ושליחה לכל מי שאינו הבעלים.
//   2. תחום תיקיות (אופציונלי): אם enforceScope פעיל, כל נתיב מחוץ לתיקיות המותרות נחסם.
import fs from 'fs'
import path from 'path'

export const norm = p => path.resolve(String(p || '')).replace(/\\/g, '/').toLowerCase()

// ---------- סיווג בסיסי ----------
const ALWAYS_OK = new Set(['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'TodoWrite', 'ToolSearch', 'Skill', 'ListMcpResourcesTool', 'ReadMcpResourceTool', 'ReadMcpResourceDirTool'])
const NEVER = new Set(['Agent', 'Task', 'RemoteTrigger', 'CronCreate', 'CronDelete', 'ScheduleWakeup', 'SendUserFile', 'PushNotification', 'SendMessage', 'SendToProject', 'SendToProjectContext', 'Workflow', 'EnterWorktree', 'ExitWorktree'])
const FORBIDDEN_WORDS = /(send|delete|trash|remove|publish|forward|reply|buy|purchase|transfer|spam|unsubscribe|place_order|cancel|share)/i
const READ_WORDS = /(^|[_-])(get|list|search|query|fetch|read|validate|health|estimate|compare|export|preview|count|aggregate|check|describe|find|insights|stats|performance|info|whoami|usage)([_-]|$)/i
const SAFE_CMDS = new Set(['ls', 'cat', 'head', 'tail', 'grep', 'wc', 'date', 'pwd', 'echo', 'find', 'sort', 'uniq', 'cut', 'jq', 'cd'])
// ערוצי הודעות חיצוניים (לא השרת המקומי). במצב approve חסומים. במצב trusted מותרים ונרשמים.
const MESSAGING = /(sendmessage|send-message|wa\.me|api\.whatsapp|graph\.facebook\.com\/[^\s]*\/messages|smtp|sendgrid|mailgun|twilio)/i

// שליחה דרך השרת המקומי של העובדים: curl יחיד ל-localhost:<port>/send עם קובץ JSON. בלי שרשור פקודות.
export function isLocalSend(cmd, port) {
  const c = String(cmd || '').trim()
  if (!/^curl\s/.test(c) || /`|\$\(/.test(c)) return false
  if (/[;&|<>]/.test(c.replace(/"[^"]*"|'[^']*'/g, '""'))) return false   // ; בתוך מרכאות (charset=utf-8) זה בסדר
  const urls = c.match(/https?:\/\/[^\s"']+/gi) || []
  const local = new RegExp(`^https?://(localhost|127\\.0\\.0\\.1):${port}/send/?$`, 'i')
  return urls.length === 1 && local.test(urls[0]) && /--data-binary\s+["']?@/.test(c)
}

// הקובץ שנשלח ב---data-binary @file (עם או בלי מרכאות, כולל נתיב עם רווחים)
export function dataFileOf(cmd) {
  const m = String(cmd).match(/--data-binary\s+(?:"@([^"]+)"|'@([^']+)'|@"([^"]+)"|@'([^']+)'|@(\S+))/)
  return m ? m.slice(1).find(Boolean) : null
}

function bashIsSafe(cmd, { preApproved = [], port }) {
  if (isLocalSend(cmd, port)) return true    // הבעלים ביקש לשלוח הודעה: זה התפקיד, לא צריך אישור נוסף
  if (MESSAGING.test(cmd)) return 'never'
  if (preApproved.some(re => re.test(cmd.trim()))) return true
  // בדיקות גרסה ומצב התחברות (קריאה בלבד), בשביל first-run
  if (/^(ffmpeg|ffprobe|node|npm|git|gh|vercel|claude|whisper-cli|brew|winget)\s+(-version|--version|-v)\s*$/.test(cmd.trim())) return true
  if (/^(gh auth status|vercel whoami)\s*$/.test(cmd.trim())) return true
  if (/[>`]|\$\(/.test(cmd)) return false
  if (/\s-(exec|execdir|delete|ok|fprint)\b|method=(post|delete)|\s-X\b/i.test(cmd)) return false
  for (const seg of cmd.split(/&&|\|\||;|\|/)) {
    const first = seg.trim().split(/\s+/)[0]
    if (!first) continue
    if (first === 'curl') {
      if (/\s(-X|--request|-d|--data|--data-binary|--data-raw|-F|--form|-T|--upload-file|-o|--output)\b/.test(' ' + seg)) return false
      continue
    }
    if (!SAFE_CMDS.has(first)) return false
  }
  return true
}

// מחזיר ['allow'] | ['deny', סיבה] | ['approve'].  'allow' = פעולת קריאה (או כתיבה בתיקייה של העובד).
export function classify(tool, input, workerDir, { allowedDirs = [], preApproved = [], label = 'העובד', port = 3100 } = {}) {
  if (ALWAYS_OK.has(tool)) return ['allow']
  if (NEVER.has(tool)) return ['deny', `הכלי הזה לא זמין ל${label}`]
  if (['Write', 'Edit', 'NotebookEdit'].includes(tool)) {
    const fp = norm(input?.file_path || input?.notebook_path)
    if ([workerDir, ...allowedDirs].some(d => fp.startsWith(norm(d) + '/'))) return ['allow']
    return ['approve']
  }
  if (tool === 'Bash') {
    const s = bashIsSafe(String(input?.command || ''), { preApproved, port })
    if (s === 'never') return ['deny', `אסור ל${label} לשלוח הודעות בערוץ הזה. לשלוח רק דרך /send של השרת המקומי`]
    return s ? ['allow'] : ['approve']
  }
  if (tool === 'PowerShell') return ['approve']
  if (tool.startsWith('mcp__')) {
    const short = tool.split('__').slice(2).join('__')
    if (FORBIDDEN_WORDS.test(short)) return ['deny', `פעולה אסורה ל${label} במצב אישורים (שליחה/מחיקה/פרסום/כסף)`]
    if (READ_WORDS.test(short)) return ['allow']
    return ['approve']
  }
  return ['approve']
}

// ---------- תחום תיקיות ----------
const inside = (fp, roots) => roots.some(r => fp === norm(r) || fp.startsWith(norm(r) + '/'))
const SHELL_PATHS = /(?:(?<![A-Za-z])[A-Za-z]:[\/](?![\/])[^\s"'|;&<>]*|(?:^|[\s"'=])(?:\.\.[\/]?)+[^\s"'|;&<>]*|(?:^|[\s"'=])\/(?:[a-z]|users|home|etc|root|mnt|var|opt|tmp|private|library|applications|volumes)(?=[\/\s"']|$)[^\s"'|;&<>]*)/gi
export function outOfScope(tool, input, cwd, roots) {
  const res = p => norm(path.resolve(cwd, String(p).trim().replace(/^["'=\s]+/, '')))
  const paths = []
  if (['Read', 'Write', 'Edit', 'NotebookEdit'].includes(tool)) paths.push(input?.file_path || input?.notebook_path)
  if (['Glob', 'Grep'].includes(tool)) { if (input?.path) paths.push(input.path); if (/^([A-Za-z]:|[\/]|~)/.test(input?.pattern || '')) paths.push(input.pattern.replace(/[*?{[].*$/, '') || '/') }
  if (tool === 'Bash' || tool === 'PowerShell') {
    const cmd = String(input?.command || '')
    if (/(\$HOME|%USERPROFILE%|\$env:|(^|\s)~)/i.test(cmd)) return 'נתיב שמחוץ לתיקיות המותרות'
    for (const m of cmd.match(SHELL_PATHS) || []) {
      let t = m.trim().replace(/^["'=]/, '')
      if (process.platform === 'win32' && /^\/[a-z]([\/]|$)/i.test(t)) t = t.replace(/^\/([a-z])/i, '$1:')   // Git Bash: /c/... = C:/...
      paths.push(t)
    }
  }
  for (const p of paths.filter(Boolean)) if (!inside(res(p), roots)) return `הנתיב ${p} מחוץ לתיקיות שהעובד רשאי לראות`
  return null
}

// ---------- תוכן זר בהקשר ----------
// מה מכניס תוכן זר להקשר דרך כלי: חיפוש/קריאה ברשת, קריאת מיילים/הודעות/תגובות מ-MCP,
// קריאת קבצים שהתקבלו בווצאפ (תיקיית media) או יומן הקבוצה.
const FOREIGN_MCP = /(^|[_-])(mail|email|gmail|inbox|message|messages|thread|threads|conversation|conversations|comment|comments|chat|dm|lead|leads|submission|submissions|review|reviews)([_-]|$)/i
export function bringsForeignContent(tool, input, { mediaDir } = {}) {
  if (tool === 'WebFetch' || tool === 'WebSearch') return true
  if (tool.startsWith('mcp__') && FOREIGN_MCP.test(tool.split('__').slice(2).join('__'))) return true
  const s = JSON.stringify(input || {})
  if (/group-log\.jsonl/i.test(s)) return true
  if (mediaDir && s.replace(/\\\\/g, '/').toLowerCase().includes(norm(mediaDir))) return true
  return false
}

// מה חסום כשיש תוכן זר בהקשר
const SECRET_RX = /secrets\.(mjs|json)|\.env(\b|\.)|credentials|id_rsa|id_ed25519|\.ssh[\/\\]|keychain|find-generic-password|cmdkey|credread|rclone\.conf|[\/\\]\.claude[\/\\](?!projects)|auth[\/\\]creds\.json|server[\/\\]auth/i
const DELETE_RX = /\b(rm|rmdir|del|erase|unlink|rimraf|shred)\b|remove-item|clear-content|\btrash\b|secrets\.mjs\s+delete|-delete\b/i
const SEND_RX = /\/send\b|sendmessage|send-message|wa\.me|api\.whatsapp|smtp|sendgrid|mailgun|twilio|\/messages\b/i
const SEND_TOOL = /(^|[_-])(send|forward|reply|post_message|publish|share|invite)([_-]|$)/i

// האם הפקודה שולחת רק לבעלים: קריאה ל-/send המקומי, וכל קובץ JSON שהיא שולחת מכיל to של הבעלים
export function sendsOnlyToOwner(cmd, { port, ownerIds = [], countryCode = '972', cwd = process.cwd() }) {
  if (!isLocalSend(cmd, port)) return false
  const f = dataFileOf(cmd)
  if (!f) return false
  let fp = f
  if (process.platform === 'win32' && /^\/[a-z]\//i.test(fp)) fp = fp.replace(/^\/([a-z])/i, '$1:')   // Git Bash
  fp = path.resolve(cwd, fp)
  let j
  try { j = JSON.parse(fs.readFileSync(fp, 'utf8').replace(/^\uFEFF/, '')) } catch { return false }
  let to = String(j.to || '').split('@')[0].replace(/\D/g, '')
  if (!to) return false                                  // בלי to = לקבוצה, ובקבוצה יש עוד אנשים
  if (to.startsWith('0')) to = countryCode + to.slice(1)
  return ownerIds.map(x => String(x).replace(/\D/g, '')).filter(Boolean).includes(to)
}

export function dangerousUnderTaint(tool, input, ctx) {
  const s = JSON.stringify(input || {})
  const short = tool.startsWith('mcp__') ? tool.split('__').slice(2).join('__') : tool
  const shell = tool === 'Bash' || tool === 'PowerShell'
  const why = 'יש בהקשר תוכן שלא הגיע מהבעלים (קבוצה, קובץ מועבר, רשת או מייל)'
  const ask = 'אם הבעלים רוצה את זה, שיכתוב לך את הבקשה ישירות בהודעה חדשה, בלי התוכן הזה.'
  if (SECRET_RX.test(s)) return `${why}, אז גישה לסודות ולמפתחות חסומה כרגע. ${ask}`
  if (shell && DELETE_RX.test(s)) return `${why}, אז מחיקה חסומה כרגע. ${ask}`
  if (tool.startsWith('mcp__') && /(^|[_-])(delete|trash|remove|destroy|archive)([_-]|$)/i.test(short)) return `${why}, אז מחיקה חסומה כרגע. ${ask}`
  if (shell && sendsOnlyToOwner(String(input?.command || ''), ctx)) return null
  if (SEND_RX.test(s) || (tool.startsWith('mcp__') && SEND_TOOL.test(short))) return `${why}, אז שליחה למי שאינו הבעלים חסומה כרגע (לבעלים מותר, דרך /send עם to של הבעלים). ${ask}`
  return null
}

// ---------- יומן ----------
// מסתיר מחרוזות שנראות כמו מפתחות לפני כתיבה ליומן
export function redact(s) {
  return String(s)
    .replace(/(sk-[A-Za-z0-9_-]{8})[A-Za-z0-9_-]+/g, '$1***')
    .replace(/((?:token|key|secret|password|pass|authorization|bearer)["'\s:=]+)[^"'\s,}]{6,}/gi, '$1***')
    .replace(/[A-Za-z0-9_\-+=]{32,}/g, m => m.slice(0, 4) + '***')
}
