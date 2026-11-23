// מריץ את שרת העובדים ומקים אותו מחדש אם נפל (המקבילה של run.ps1, לכל מערכת הפעלה).
// ב-Mac ה-LaunchAgent מפעיל את הקובץ הזה ישירות עם node, כך שהתהליך שמקבל Full Disk Access הוא node עצמו
// (ולא bash או Terminal), וכל התהליכים שהשרת מפעיל (Claude, ffmpeg, whisper) יורשים את ההרשאה.
// קודי יציאה של index.js: 3 = העובדים עברו למחשב אחר, 4 = מחשב אחר מחזיק את החיבור. לא חוזרים.
// 0 = workers.json השתנה, כל קוד אחר = קריסה: עולים מחדש.
import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const LOG = path.join(DIR, 'server.log')
const stamp = () => new Date().toISOString().slice(0, 19)
const note = t => fs.appendFileSync(LOG, `===== ${stamp()} ${t}\n`)

// Mac: לא להירדם כל עוד השרת רץ (על חשמל). מכסה סגור עדיין מרדים, ראו README.
if (process.platform === 'darwin') {
  try { spawn('caffeinate', ['-ism', '-w', String(process.pid)], { stdio: 'ignore', detached: true }).unref() } catch {}
}

let child = null
function start() {
  note(`הפעלה ב-${os.hostname()}`)
  const out = fs.openSync(LOG, 'a')
  child = spawn(process.execPath, [path.join(DIR, 'index.js')], { cwd: DIR, stdio: ['ignore', out, out], env: process.env })
  child.on('exit', code => {
    fs.closeSync(out)
    note(`השרת נעצר (קוד ${code})`)
    if (code === 3 || code === 4) { note('השרת רץ במחשב אחר. העוטף נעצר.'); process.exit(0) }
    setTimeout(start, 10000)
  })
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { try { child?.kill(sig) } catch {} setTimeout(() => process.exit(0), 1500) })
start()
