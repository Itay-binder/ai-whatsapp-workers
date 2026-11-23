// מנוע המוח Claude: סשן Claude רציף (Agent SDK, streaming input) + hook שמפעיל את מדיניות ההרשאות (policy.js).
// סשן אחד ליום לכל עובד (נשמר ב-state/session.json), נפתח מחדש אוטומטית ביום חדש או על "שיחה חדשה".
// הממשק שהשרת מצפה לו מכל מנוע מתועד ב-brains.js.
import { query } from '@anthropic-ai/claude-agent-sdk'
import fs from 'fs'
import path from 'path'
import { classify, outOfScope, bringsForeignContent, dangerousUnderTaint, redact } from './policy.js'

// תאימות לאחור: מי שייבא את הפונקציות האלה מ-brain.js
export { classify, outOfScope } from './policy.js'

export function createBrain({
  cwd, workerDir, allowedDirs = [], rolePrompt, onReply, onTyping, onApproval, log,
  ownerName = 'הבעלים', workerLabel = 'העובד', timezone = 'Asia/Jerusalem', preApproved = [],
  mode = 'approve',           // 'approve' | 'trusted'
  enforceScope = mode !== 'trusted',
  port = 3100, ownerIds = [], countryCode = '972', mediaDir = null,
}) {
  const stateDir = path.join(workerDir, 'state')
  fs.mkdirSync(stateDir, { recursive: true })
  const sessFile = path.join(stateDir, 'session.json')
  const approvalsLog = path.join(stateDir, 'approvals.log')
  const audit = line => fs.appendFileSync(approvalsLog, `${new Date().toISOString()} ${redact(line).replace(/\n/g, ' ')}\n`)
  const today = () => new Date().toLocaleDateString('en-CA', { timeZone: timezone })
  const pre = preApproved.map(s => new RegExp(s))
  const policy = { allowedDirs, preApproved: pre, label: workerLabel, port }
  const taintCtx = { port, ownerIds, countryCode, cwd }
  const roots = [cwd, workerDir, ...allowedDirs]
  const trusted = mode === 'trusted'

  let inbox = [], wake = null, closed = false
  let targets = []         // לאן לשלוח כל תשובה, לפי הסדר
  let current = null       // הצ'אט של התור הנוכחי
  let tainted = false      // תוכן שלא הגיע מהבעלים נמצא בהקשר של התור הנוכחי
  let taints = []          // מקביל ל-targets: האם ההודעה של כל תור כללה תוכן זר
  let session = fs.existsSync(sessFile) ? JSON.parse(fs.readFileSync(sessFile, 'utf8')) : {}
  let running = null, gen = 0

  function saveSession() { fs.writeFileSync(sessFile, JSON.stringify(session)) }

  async function* input(myGen) {
    while (myGen === gen) {
      if (!inbox.length) { await new Promise(r => (wake = r)); continue }
      const { text, chat, taint } = inbox.shift()
      if (taint) tainted = true
      targets.push(chat); taints.push(!!taint)
      yield { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: session.id || '' }
    }
  }

  async function preToolUse(hookInput) {
    const tool = hookInput.tool_name, inp = hookInput.tool_input
    const out = (d, r) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: d, permissionDecisionReason: r } })

    // 1. תוכן זר: הכלי הזה מכניס תוכן מבחוץ = מכאן ועד סוף התור, חוסמים מחיקה, סודות ושליחה לאחרים
    if (bringsForeignContent(tool, inp, { mediaDir })) tainted = true
    if (tainted) {
      const bad = dangerousUnderTaint(tool, inp, taintCtx)
      if (bad) { log(`חסום (תוכן זר בהקשר): ${tool}`); audit(`חסום, תוכן זר בהקשר: ${tool} ${JSON.stringify(inp).slice(0, 300)}`); return out('deny', bad) }
    }

    // 2. תחום תיקיות (אם הוגדר)
    if (enforceScope) {
      const scope = outOfScope(tool, inp, cwd, roots)
      if (scope) { log(`חסום (תחום): ${tool}`); return out('deny', scope + '. לעבוד רק בתוך התיקיות המותרות.') }
    }

    const [decision, reason] = classify(tool, inp, workerDir, policy)

    // 3. מצב trusted: הכל מותר בלי לשאול. כל פעולה שאינה קריאה נרשמת ביומן.
    if (trusted) {
      if (decision !== 'allow') audit(`בוצע (trusted): ${tool} ${JSON.stringify(inp).slice(0, 500)}`)
      return out('allow', 'מצב trusted: הבעלים סומך על העובד')
    }

    // 4. מצב approve
    if (decision === 'allow') return out('allow', 'מותר')
    if (decision === 'deny') { log(`חסום: ${tool}`); return out('deny', reason) }
    audit(`בקשה: ${tool} ${JSON.stringify(inp).slice(0, 700)}`)
    const ok = await onApproval(current || targets[0], tool, inp)
    audit(`${ok ? 'אושר' : 'נדחה'}: ${tool}`)
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
      // תמיד 'default' + hook. לא bypassPermissions: במצב הזה המודל נוטה להתווכח ולסרב בעצמו.
      permissionMode: 'default',
      hooks: { PreToolUse: [{ hooks: [preToolUse], timeout: 900 }] },
      stderr: d => { if (/error/i.test(d)) log('stderr: ' + d.slice(0, 300)) },
    }
    if (session.id) opts.resume = session.id
    log(`מוח Claude עולה, מצב ${mode}${enforceScope ? ' + תחום תיקיות' : ''} (${session.id ? 'ממשיך סשן ' + session.id.slice(0, 8) : 'סשן חדש'})`)
    const typing = setInterval(() => { if (current) onTyping(current) }, 8000)
    try {
      for await (const m of query({ prompt: input(myGen), options: opts })) {
        if (m.session_id && m.session_id !== session.id) { session.id = m.session_id; saveSession() }
        if (m.type === 'assistant' && !current) { current = targets[0]; onTyping(current) }
        if (m.type === 'result') {
          const chat = targets.shift(); taints.shift(); current = null
          tainted = taints.some(Boolean)   // התור הבא נקי, אלא אם גם הוא הגיע עם תוכן זר
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
    taints = []; tainted = false
    for (const chat of targets.splice(0)) await onReply(chat, 'נפלתי באמצע ההודעה הזאת. אני חוזר עכשיו, לשלוח אותה שוב.')
    current = null
    setTimeout(() => { running = run() }, 3000)
  }

  return {
    // taint = true כשההודעה כוללת תוכן שלא כתב הבעלים (יומן קבוצה, קובץ או הקלטה מועברים)
    ask(chat, text, taint = false) {
      if (session.date && session.date !== today() && !targets.length) this.reset('יום חדש')
      inbox.push({ chat, text, taint })
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
