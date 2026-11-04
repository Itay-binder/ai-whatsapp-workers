// המוח של עובד: סשן Claude רציף (Agent SDK, streaming input) + בלם על פעולות כתיבה.
// סשן אחד ליום לכל עובד (נשמר ב-state/session.json), נפתח מחדש אוטומטית ביום חדש או על "שיחה חדשה".
import { query } from '@anthropic-ai/claude-agent-sdk'
import fs from 'fs'
import path from 'path'

const norm = p => path.resolve(String(p || '')).replace(/\\/g, '/').toLowerCase()

// ---------- מדיניות הרשאות ----------
// allow = מבצע לבד. deny = חסום תמיד. approve = שולח לבעלים "אישור נדרש" ומחכה ל"מאשר"/"לא".
const ALWAYS_OK = new Set(['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'TodoWrite', 'ToolSearch', 'Skill', 'ListMcpResourcesTool', 'ReadMcpResourceTool', 'ReadMcpResourceDirTool'])
const NEVER = new Set(['Agent', 'Task', 'RemoteTrigger', 'CronCreate', 'CronDelete', 'ScheduleWakeup', 'SendUserFile', 'PushNotification', 'SendMessage', 'SendToProject', 'SendToProjectContext', 'Workflow', 'EnterWorktree', 'ExitWorktree'])
const FORBIDDEN_WORDS = /(send|delete|trash|remove|publish|forward|reply|buy|purchase|transfer|spam|unsubscribe|place_order|cancel|share)/i
const READ_WORDS = /(^|[_-])(get|list|search|query|fetch|read|validate|health|estimate|compare|export|preview|count|aggregate|check|describe|find|insights|stats|performance|info|whoami|usage)([_-]|$)/i
const SAFE_CMDS = new Set(['ls', 'cat', 'head', 'tail', 'grep', 'wc', 'date', 'pwd', 'echo', 'find', 'sort', 'uniq', 'cut', 'jq', 'cd'])
// פקודות שנראות כמו שליחת הודעות/מיילים בערוצים חיצוניים. חסומות במצב רגיל. שימו לב: במצב bypass הכל מותר ורק נרשם ב-approvals.log.
const MESSAGING = /(sendmessage|send-message|wa\.me|api\.whatsapp|graph\.facebook\.com\/[^\s]*\/messages|smtp|sendgrid|mailgun|twilio)/i

function bashIsSafe(cmd, preApproved) {
  if (MESSAGING.test(cmd)) return 'never'
  // פקודות שאושרו מראש ב-workers.json (preApprovedCommands: מערך של regex), למשל סקריפט דוח במצב בדיקה
  if (preApproved.some(re => re.test(cmd.trim()))) return true
  if (/[>`]|\$\(/.test(cmd)) return false
  if (/\s-(exec|execdir|delete|ok|fprint)\b|method=(post|delete)|\s-X\b/i.test(cmd)) return false
  for (const seg of cmd.split(/&&|\|\||;|\|/)) {
    const words = seg.trim().split(/\s+/)
    const first = words[0]
    if (!first) continue
    if (first === 'curl') {
      if (/\s(-X|--request|-d|--data|--data-binary|--data-raw|-F|--form|-T|--upload-file|-o|--output)\b/.test(' ' + seg)) return false
      continue
    }
    if (!SAFE_CMDS.has(first)) return false
  }
  return true
}

// ---------- תחום תיקיות ----------
// העובד רואה רק את workspaceDir (cwd), את התיקייה של עצמו ואת allowedDirs.
// כל נתיב מחוץ להם נחסם, גם בקריאה וגם במצב bypass. זו שכבת הגנה, לא כספת:
// מידע רגיש באמת לא שמים מתחת לתיקייה שהעובד רואה.
const inside = (fp, roots) => roots.some(r => fp === norm(r) || fp.startsWith(norm(r) + '/'))
const SHELL_PATHS = /(?:(?<![A-Za-z])[A-Za-z]:[\/](?![\/])[^\s"'|;&<>]*|(?:^|[\s"'=])(?:\.\.[\/]?)+[^\s"'|;&<>]*|(?:^|[\s"'=])\/(?:[a-z]|users|home|etc|root|mnt|var|opt|tmp)(?=[\/\s"']|$)[^\s"'|;&<>]*)/gi
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
      if (/^\/[a-z]([\/]|$)/i.test(t)) t = t.replace(/^\/([a-z])/i, '$1:')   // Git Bash: /c/... = C:/...
      paths.push(t)
    }
  }
  for (const p of paths.filter(Boolean)) if (!inside(res(p), roots)) return `הנתיב ${p} מחוץ לתיקיות שהעובד רשאי לראות`
  return null
}

// מחזיר ['allow'] | ['deny', סיבה] | ['approve']
export function classify(tool, input, workerDir, { allowedDirs = [], preApproved = [], label = 'העובד' } = {}) {
  if (ALWAYS_OK.has(tool)) return ['allow']
  if (NEVER.has(tool)) return ['deny', `הכלי הזה לא זמין ל${label}`]
  if (['Write', 'Edit', 'NotebookEdit'].includes(tool)) {
    const fp = norm(input?.file_path || input?.notebook_path)
    // כתיבה בתיקייה של העובד עצמו (זיכרון, state) או בתיקיות שהוגדרו ב-allowedDirs = מותרת
    if ([workerDir, ...allowedDirs].some(d => fp.startsWith(norm(d) + '/'))) return ['allow']
    return ['approve']
  }
  if (tool === 'Bash') {
    const s = bashIsSafe(String(input?.command || ''), preApproved)
    if (s === 'never') return ['deny', `אסור ל${label} לשלוח הודעות לאחרים בדרך הזאת. לשלוח רק דרך /send של השרת`]
    return s ? ['allow'] : ['approve']
  }
  if (tool === 'PowerShell') return ['approve']
  if (tool.startsWith('mcp__')) {
    const short = tool.split('__').slice(2).join('__')
    if (FORBIDDEN_WORDS.test(short)) return ['deny', `פעולה אסורה ל${label} (שליחה/מחיקה/פרסום/כסף)`]
    if (READ_WORDS.test(short)) return ['allow']
    return ['approve']
  }
  return ['approve']
}

// ---------- המוח ----------
export function createBrain({
  cwd, workerDir, allowedDirs = [], rolePrompt, onReply, onTyping, onApproval, log,
  ownerName = 'הבעלים', workerLabel = 'העובד', timezone = 'Asia/Jerusalem', preApproved = [], bypass = false,
}) {
  const stateDir = path.join(workerDir, 'state')
  fs.mkdirSync(stateDir, { recursive: true })
  const sessFile = path.join(stateDir, 'session.json')
  const approvalsLog = path.join(stateDir, 'approvals.log')
  const today = () => new Date().toLocaleDateString('en-CA', { timeZone: timezone })
  const pre = preApproved.map(s => new RegExp(s))
  const policy = { allowedDirs, preApproved: pre, label: workerLabel }
  const roots = [cwd, workerDir, ...allowedDirs]

  let inbox = [], wake = null, closed = false
  let targets = []         // לאן לשלוח כל תשובה, לפי הסדר
  let current = null       // הצ'אט של התור הנוכחי
  let session = fs.existsSync(sessFile) ? JSON.parse(fs.readFileSync(sessFile, 'utf8')) : {}
  let running = null, gen = 0

  function saveSession() { fs.writeFileSync(sessFile, JSON.stringify(session)) }

  async function* input(myGen) {
    while (myGen === gen) {
      if (!inbox.length) { await new Promise(r => (wake = r)); continue }
      const { text, chat } = inbox.shift()
      targets.push(chat)
      yield { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: session.id || '' }
    }
  }

  async function preToolUse(hookInput) {
    const tool = hookInput.tool_name, inp = hookInput.tool_input
    const [decision, reason] = classify(tool, inp, workerDir, policy)
    const out = (d, r) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: d, permissionDecisionReason: r } })
    // תחום התיקיות נאכף תמיד, לפני הכל, גם במצב bypass
    const scope = outOfScope(tool, inp, cwd, roots)
    if (scope) { log(`חסום (תחום): ${tool}`); return out('deny', scope + '. לעבוד רק בתוך התיקיות המותרות.') }
    if (bypass) {
      // מצב bypass: בלי אישורים. כל פעולה שאינה קריאה נרשמת ביומן approvals.log.
      if (decision !== 'allow') fs.appendFileSync(approvalsLog, `${new Date().toISOString()} בוצע בלי אישור: ${tool} ${JSON.stringify(inp).slice(0, 500)}\n`)
      return out('allow', 'מצב bypass')
    }
    if (decision === 'allow') return out('allow', 'מותר')
    if (decision === 'deny') { log(`חסום: ${tool}`); return out('deny', reason) }
    const desc = `${tool}\n${JSON.stringify(inp).slice(0, 700)}`
    fs.appendFileSync(approvalsLog, `${new Date().toISOString()} בקשה: ${desc.replace(/\n/g, ' ')}\n`)
    const ok = await onApproval(current || targets[0], tool, inp)
    fs.appendFileSync(approvalsLog, `${new Date().toISOString()} ${ok ? 'אושר' : 'נדחה'}: ${tool}\n`)
    return ok ? out('allow', `${ownerName} אישר/ה`) : out('deny', `${ownerName} לא אישר/ה את הפעולה. אל תנסה שוב בדרך אחרת. לשאול מה עדיף.`)
  }

  async function run() {
    const myGen = ++gen
    if (session.date !== today()) session = { date: today() }
    const opts = {
      cwd,
      additionalDirectories: [workerDir, ...allowedDirs],
      settingSources: ['user', 'project', 'local'],
      systemPrompt: { type: 'preset', preset: 'claude_code', append: rolePrompt },
      permissionMode: 'default',
      hooks: { PreToolUse: [{ hooks: [preToolUse], timeout: 900 }] },
      stderr: d => { if (/error/i.test(d)) log('stderr: ' + d.slice(0, 300)) },
    }
    if (session.id) opts.resume = session.id
    log(`מוח עולה (${session.id ? 'ממשיך סשן ' + session.id.slice(0, 8) : 'סשן חדש'})`)
    const typing = setInterval(() => { if (current) onTyping(current) }, 8000)
    try {
      for await (const m of query({ prompt: input(myGen), options: opts })) {
        if (m.session_id && m.session_id !== session.id) { session.id = m.session_id; saveSession() }
        if (m.type === 'assistant' && !current) { current = targets[0]; onTyping(current) }
        if (m.type === 'result') {
          const chat = targets.shift(); current = null
          const text = m.subtype === 'success' ? (m.result || '').trim() : `נתקלתי בשגיאה (${m.subtype}). לנסות שוב או לנסח אחרת.`
          if (chat && text) await onReply(chat, text)
          if (targets.length) { current = targets[0]; onTyping(current) }
        }
      }
    } catch (e) {
      log('המוח נפל: ' + e.message)
    } finally {
      clearInterval(typing)
    }
    if (myGen !== gen || closed) return
    // נפל: להודיע על מה שלא נענה ולהקים מחדש
    for (const chat of targets.splice(0)) await onReply(chat, 'נפלתי באמצע ההודעה הזאת. אני חוזר עכשיו, לשלוח אותה שוב.')
    current = null
    setTimeout(() => { running = run() }, 3000)
  }

  return {
    ask(chat, text) {
      if (session.date && session.date !== today() && !targets.length) this.reset('יום חדש')
      inbox.push({ chat, text })
      if (!running) running = run()
      wake?.(); wake = null
    },
    reset(why = 'בקשה') {
      log(`שיחה חדשה (${why})`)
      session = { date: today() }; saveSession()
      gen++; wake?.(); wake = null
      running = null
    },
    close() { closed = true; gen++; wake?.(); wake = null },
    busy: () => targets.length > 0 || inbox.length > 0,
  }
}
