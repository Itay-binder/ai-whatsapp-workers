#!/usr/bin/env node
// כספת סודות לעובדים: מפתחות API וטוקנים של מערכות שהבעלים חיבר (סקיל connect-system).
// ברירת מחדל: הכספת של מערכת ההפעלה.
//   Windows: Credential Manager (Generic Credential בשם ai-whatsapp-workers:<שם>)
//   macOS:   Keychain (security, שירות ai-whatsapp-workers, חשבון <שם>)
//   Linux:   secret-tool (libsecret) אם מותקן, אחרת קובץ
// אפשרות לסנכרון בין כמה מחשבים: backend "file", קובץ JSON מקומי מחוץ לכל ריפו גיט (הרשאות 600).
// הגדרה: "node secrets.mjs config ...", או ב-server/workers.json:  "secrets": { "backend": "os" | "file", "file": "~/.ai-workers/secrets.json" }
// או במשתני סביבה: AIW_SECRETS_BACKEND, AIW_SECRETS_FILE.
//
// שימוש (שורת פקודה):
//   node secrets.mjs set <שם> --from-file <קובץ>   שומר את תוכן הקובץ ומוחק את הקובץ (כך המפתח לא מופיע בשום פקודה)
//   node secrets.mjs set <שם>                      קורא את הערך מ-stdin
//   node secrets.mjs run <שם> <משתנה> -- <פקודה>    מריץ פקודה עם הסוד במשתנה סביבה, ומסתיר אותו בפלט
//   node secrets.mjs has <שם>  |  list  |  where  |  delete <שם>
//   node secrets.mjs config os | config file [נתיב]  בחירת כספת (נשמר ב-~/.ai-workers/config.json)
//   node secrets.mjs get <שם>                      מדפיס את הערך. להימנע: הפלט נכנס להקשר של העובד. עדיף run
// שימוש מקוד:  import { getSecret } from './secrets.mjs'
import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

const SERVICE = 'ai-whatsapp-workers'
const DIR = path.dirname(fileURLToPath(import.meta.url))
const HOME_DIR = path.join(os.homedir(), '.ai-workers')
const INDEX = path.join(HOME_DIR, 'secrets-index.json')   // רק שמות ותאריכים, בלי ערכים
const expand = p => String(p).replace(/^~(?=$|[\/\\])/, os.homedir())

// סדר עדיפות: משתני סביבה, אחר כך workers.json, אחר כך ~/.ai-workers/config.json (נכתב ע"י "config", בלי להפעיל מחדש את השרת)
const USER_CFG = path.join(HOME_DIR, 'config.json')
function settings() {
  let s = {}
  try { s = JSON.parse(fs.readFileSync(USER_CFG, 'utf8')).secrets || {} } catch {}
  try { s = { ...s, ...(JSON.parse(fs.readFileSync(path.join(DIR, 'workers.json'), 'utf8')).secrets || {}) } } catch {}
  const backend = process.env.AIW_SECRETS_BACKEND || s.backend || 'os'
  const file = path.resolve(expand(process.env.AIW_SECRETS_FILE || s.file || path.join(HOME_DIR, 'secrets.json')))
  return { backend, file }
}

const validName = n => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(String(n || ''))
function need(name) { if (!validName(name)) throw new Error(`שם סוד לא תקין: "${name}". רק אותיות באנגלית, ספרות, נקודה, מקף וקו תחתון`) }

// ---------- backend: קובץ ----------
function insideGitRepo(p) {
  let d = path.dirname(p)
  while (true) {
    if (fs.existsSync(path.join(d, '.git'))) return d
    const up = path.dirname(d)
    if (up === d) return null
    d = up
  }
}
function fileStore(file) {
  const repo = insideGitRepo(file)
  if (repo) throw new Error(`קובץ הסודות ${file} נמצא בתוך ריפו גיט (${repo}). להגדיר secrets.file מחוץ לכל ריפו`)
  const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return {} } }
  const write = obj => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(obj, null, 2), { mode: 0o600 })
    try { fs.chmodSync(file, 0o600) } catch {}
  }
  return {
    get: n => read()[n] ?? null,
    set: (n, v) => { const o = read(); o[n] = v; write(o) },
    del: n => { const o = read(); const had = n in o; delete o[n]; write(o); return had },
  }
}

// ---------- backend: Windows Credential Manager ----------
const WIN_CS = `
using System; using System.Runtime.InteropServices; using System.Text;
public static class AiwCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct CREDENTIAL { public int Flags; public int Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob;
    public int Persist; public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }
  [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredWrite(ref CREDENTIAL c, int flags);
  [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredRead(string t, int type, int flags, out IntPtr c);
  [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredDelete(string t, int type, int flags);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr p);
  public static void Write(string t, string user, string secret) {
    byte[] b = Encoding.UTF8.GetBytes(secret); var c = new CREDENTIAL(); c.Type = 1; c.TargetName = t; c.UserName = user; c.Persist = 2;
    c.CredentialBlobSize = b.Length; c.CredentialBlob = Marshal.AllocHGlobal(b.Length); Marshal.Copy(b, 0, c.CredentialBlob, b.Length);
    try { if (!CredWrite(ref c, 0)) throw new Exception("CredWrite failed " + Marshal.GetLastWin32Error()); } finally { Marshal.FreeHGlobal(c.CredentialBlob); } }
  public static string Read(string t) { IntPtr p; if (!CredRead(t, 1, 0, out p)) return null;
    try { var c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL)); byte[] b = new byte[c.CredentialBlobSize];
      Marshal.Copy(c.CredentialBlob, b, 0, b.Length); return Convert.ToBase64String(b); } finally { CredFree(p); } }
  public static bool Delete(string t) { return CredDelete(t, 1, 0); }
}`
function winPs(op, target, value) {
  // הערך עובר במשתנה סביבה של התהליך (לא בשורת הפקודה), והסקריפט ב-EncodedCommand
  const body = {
    get: '$r = [AiwCred]::Read($env:AIW_T); if ($r) { [Console]::Out.Write($r) } else { exit 3 }',
    set: '[AiwCred]::Write($env:AIW_T, $env:AIW_U, $env:AIW_V)',
    del: 'if (-not [AiwCred]::Delete($env:AIW_T)) { exit 3 }',
  }[op]
  const script = `$ErrorActionPreference='Stop'\nAdd-Type -TypeDefinition @'\n${WIN_CS}\n'@\n${body}`
  const enc = Buffer.from(script, 'utf16le').toString('base64')
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc], {
    env: { ...process.env, AIW_T: target, AIW_U: SERVICE, AIW_V: value ?? '' }, encoding: 'utf8', windowsHide: true,
  })
  if (r.status === 3) return null
  if (r.status !== 0) throw new Error('Credential Manager: ' + (r.stderr || r.error?.message || '').trim().slice(0, 300))
  return r.stdout
}
const winStore = {
  get: n => { const b = winPs('get', `${SERVICE}:${n}`); return b ? Buffer.from(b.trim(), 'base64').toString('utf8') : null },
  set: (n, v) => { winPs('set', `${SERVICE}:${n}`, v) },
  del: n => winPs('del', `${SERVICE}:${n}`) !== null,
}

// ---------- backend: macOS Keychain ----------
// הערה: security מקבל את הערך כארגומנט (-w), כך שהוא גלוי לרגע ברשימת התהליכים של המחשב. מקובל במחשב אישי.
const macStore = {
  get: n => { const r = spawnSync('security', ['find-generic-password', '-s', SERVICE, '-a', n, '-w'], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.replace(/\n$/, '') : null },
  set: (n, v) => { const r = spawnSync('security', ['add-generic-password', '-U', '-s', SERVICE, '-a', n, '-l', `${SERVICE}: ${n}`, '-w', v], { encoding: 'utf8' }); if (r.status !== 0) throw new Error('Keychain: ' + (r.stderr || '').trim()) },
  del: n => spawnSync('security', ['delete-generic-password', '-s', SERVICE, '-a', n], { encoding: 'utf8' }).status === 0,
}

// ---------- backend: Linux secret-tool ----------
const hasCmd = c => spawnSync(c, ['--version'], { encoding: 'utf8' }).error === undefined
const linuxStore = {
  get: n => { const r = spawnSync('secret-tool', ['lookup', 'service', SERVICE, 'account', n], { encoding: 'utf8' }); return r.status === 0 && r.stdout ? r.stdout.replace(/\n$/, '') : null },
  set: (n, v) => { const r = spawnSync('secret-tool', ['store', `--label=${SERVICE}: ${n}`, 'service', SERVICE, 'account', n], { input: v, encoding: 'utf8' }); if (r.status !== 0) throw new Error('secret-tool: ' + (r.stderr || '').trim()) },
  del: n => spawnSync('secret-tool', ['clear', 'service', SERVICE, 'account', n]).status === 0,
}

function store() {
  const { backend, file } = settings()
  if (backend === 'file') return { name: `file (${file})`, ...fileStore(file) }
  if (process.platform === 'win32') return { name: 'Windows Credential Manager', ...winStore }
  if (process.platform === 'darwin') return { name: 'macOS Keychain', ...macStore }
  if (hasCmd('secret-tool')) return { name: 'secret-tool', ...linuxStore }
  return { name: `file (${file})`, ...fileStore(file) }
}

// ---------- אינדקס שמות (בלי ערכים) ----------
const readIndex = () => { try { return JSON.parse(fs.readFileSync(INDEX, 'utf8')) } catch { return {} } }
function writeIndex(o) { fs.mkdirSync(HOME_DIR, { recursive: true }); fs.writeFileSync(INDEX, JSON.stringify(o, null, 2), { mode: 0o600 }) }

// ---------- API ----------
export function getSecret(name) { need(name); return store().get(name) }
export function hasSecret(name) { return getSecret(name) != null }
export function setSecret(name, value) {
  need(name)
  const v = String(value ?? '').replace(/^\uFEFF/, '').trim()
  if (!v) throw new Error('ערך ריק, לא נשמר')
  const s = store(); s.set(name, v)
  const ix = readIndex(); ix[name] = { backend: s.name.split(' ')[0], updated: new Date().toISOString() }; writeIndex(ix)
  return s.name
}
export function deleteSecret(name) {
  need(name)
  const had = store().del(name)
  const ix = readIndex(); delete ix[name]; writeIndex(ix)
  return had
}
export function listSecrets() { return Object.keys(readIndex()).sort() }
export function backendName() { return store().name }

// מריץ פקודה עם הסוד במשתנה סביבה. הפקודה רצה ב-bash (ב-Windows: Git Bash אם קיים, אחרת cmd עם %VAR%).
export function runWithSecret(name, envVar, command) {
  const value = getSecret(name)
  if (value == null) throw new Error(`אין סוד בשם ${name}`)
  if (!/^[A-Z_][A-Z0-9_]*$/i.test(envVar)) throw new Error(`שם משתנה לא תקין: ${envVar}`)
  let shell = '/bin/sh', args = ['-c', command]
  if (process.platform === 'win32') {
    const gitBash = ['C:/Program Files/Git/bin/bash.exe', 'C:/Program Files (x86)/Git/bin/bash.exe'].find(p => fs.existsSync(p))
    if (gitBash) shell = gitBash
    else { shell = process.env.ComSpec || 'cmd.exe'; args = ['/d', '/s', '/c', command] }
  }
  const r = spawnSync(shell, args, { env: { ...process.env, [envVar]: value }, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024, windowsHide: true })
  const mask = s => String(s || '').split(value).join('***')
  return { status: r.status ?? 1, stdout: mask(r.stdout), stderr: mask(r.stderr || r.error?.message) }
}

// ---------- שורת פקודה ----------
async function readStdin() { const chunks = []; for await (const c of process.stdin) chunks.push(c); return Buffer.concat(chunks).toString('utf8') }

async function main(argv) {
  const [cmd, name, ...rest] = argv
  switch (cmd) {
    case 'set': {
      const i = rest.indexOf('--from-file')
      let value
      if (i >= 0) {
        const f = rest[i + 1]
        if (!f || !fs.existsSync(f)) throw new Error('הקובץ לא נמצא')
        value = fs.readFileSync(f, 'utf8')
        fs.rmSync(f, { force: true })   // לא משאירים את המפתח בדיסק
      } else value = await readStdin()
      const where = setSecret(name, value)
      console.log(`נשמר: ${name} (${where}). הערך לא מודפס.`)
      return 0
    }
    case 'get': { const v = getSecret(name); if (v == null) { console.error(`אין סוד בשם ${name}`); return 1 } process.stdout.write(v); return 0 }
    case 'has': { const ok = hasSecret(name); console.log(ok ? 'yes' : 'no'); return ok ? 0 : 1 }
    case 'delete': { console.log(deleteSecret(name) ? `נמחק: ${name}` : `לא היה סוד בשם ${name}`); return 0 }
    case 'list': { const l = listSecrets(); console.log(l.length ? l.join('\n') : '(אין סודות שמורים)'); return 0 }
    case 'where': { console.log(backendName()); return 0 }
    case 'config': {
      // config os  |  config file [נתיב]   (name כאן = os/file)
      if (!['os', 'file'].includes(name)) throw new Error('שימוש: config os | config file [נתיב]')
      let c = {}; try { c = JSON.parse(fs.readFileSync(USER_CFG, 'utf8')) } catch {}
      c.secrets = { backend: name, ...(name === 'file' && rest[0] ? { file: rest[0] } : {}) }
      fs.mkdirSync(HOME_DIR, { recursive: true }); fs.writeFileSync(USER_CFG, JSON.stringify(c, null, 2))
      if (name === 'file') fileStore(settings().file)   // בודק שהקובץ לא בתוך ריפו גיט
      console.log(`הכספת עכשיו: ${backendName()}. סודות שכבר נשמרו בכספת הקודמת לא הועברו.`)
      return 0
    }
    case 'run': {
      const sep = rest.indexOf('--')
      const envVar = rest[0]
      const command = (sep >= 0 ? rest.slice(sep + 1) : rest.slice(1)).join(' ')
      if (!envVar || !command) throw new Error('שימוש: run <שם> <משתנה> -- <פקודה>')
      const r = runWithSecret(name, envVar, command)
      process.stdout.write(r.stdout); process.stderr.write(r.stderr)
      return r.status
    }
    default:
      console.log('שימוש: node secrets.mjs set|get|has|delete|list|where|run ... (פירוט בראש הקובץ)')
      return cmd ? 1 : 0
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => process.exit(code), e => { console.error('שגיאה: ' + e.message); process.exit(1) })
}
