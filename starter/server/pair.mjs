// חיבור עובד חדש עם QR בדף מקומי, בלי לגעת בשרת הראשי (שיכול לרוץ במחשב אחר).
// שימוש: node pair.mjs <id>   ואז לפתוח http://localhost:3101 (או pairPort מ-workers.json)
// בסיום: מעדכן שם/תמונה/תיאור, מוריד את "pending" מ-workers.json ויוצא. השרת הראשי רואה את השינוי, עולה מחדש וממשיך משם.
import { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, Browsers, DisconnectReason } from '@whiskeysockets/baileys'
import express from 'express'
import QRCode from 'qrcode'
import pino from 'pino'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const id = process.argv[2]
const cfgPath = path.join(DIR, 'workers.json')
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
const w = cfg.workers[id]
if (!w) { console.error('אין עובד כזה ב-workers.json:', id); process.exit(1) }
const PORT = Number(process.env.PAIR_PORT || cfg.pairPort || 3101)
const authDir = path.join(DIR, 'auth', id)
const photo = w.photo && path.join(DIR, w.photo)
const st = { status: 'מתחבר', qr: null, code: null, sock: null }

async function start() {
  fs.mkdirSync(authDir, { recursive: true })
  const { state, saveCreds } = await useMultiFileAuthState(authDir)
  const { version } = await fetchLatestBaileysVersion()
  const sock = st.sock = makeWASocket({ version, auth: state, logger: pino({ level: 'silent' }), browser: Browsers.windows('Chrome'), markOnlineOnConnect: false })
  sock.ev.on('creds.update', saveCreds)
  sock.ev.on('connection.update', async u => {
    if (st.sock !== sock) return
    if (u.qr) { st.qr = await QRCode.toDataURL(u.qr); st.status = 'ממתין לסריקה' }
    if (u.connection === 'open') { st.status = 'מחובר! מעדכן שם ותמונה...'; st.qr = null; finish(sock) }
    if (u.connection === 'close') {
      const code = u.lastDisconnect?.error?.output?.statusCode
      if (code === DisconnectReason.loggedOut) { st.status = 'נדחה. מנקה ומתחיל מחדש'; fs.rmSync(authDir, { recursive: true, force: true }) }
      st.code = null
      setTimeout(start, 3000)
    }
  })
}

async function finish(sock) {
  await new Promise(r => setTimeout(r, 15000))
  const me = sock.user.id.split(':')[0] + '@s.whatsapp.net'
  for (let i = 0; i < 5; i++) {
    try {
      if (photo && fs.existsSync(photo)) await sock.updateProfilePicture(me, fs.readFileSync(photo))
      if (w.about) await sock.updateProfileStatus(w.about)
      if (w.name) await sock.updateProfileName(w.name)
      fs.writeFileSync(path.join(authDir, 'profile-done'), new Date().toISOString())
      break
    } catch (e) { console.log('פרופיל, ניסיון', i + 1, e.message); await new Promise(r => setTimeout(r, 20000)) }
  }
  st.status = `${w.name} מחובר ומוכן. אפשר לסגור את הדף, השרת הראשי לוקח מכאן.`
  console.log(st.status)
  setTimeout(() => {
    try { sock.end(undefined) } catch {}
    // מסירה לשרת הראשי: מורידים pending, השרת עולה מחדש לבד וטוען את העובד
    const c = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
    delete c.workers[id].pending
    fs.writeFileSync(cfgPath, JSON.stringify(c, null, 2) + '\n')
    process.exit(0)
  }, 5000)
}

const app = express()
app.get('/', (req, res) => res.send(`<!doctype html><html dir="rtl" lang="he"><meta charset="utf-8"><meta http-equiv="refresh" content="4">
<title>חיבור ${w.name}</title><style>body{font-family:Arial;background:#f4f4f4;padding:24px}.c{background:#fff;padding:24px;border-radius:12px;max-width:420px}img.av{width:80px;height:80px;border-radius:50%;object-fit:cover}</style>
<div class="c"><img class="av" src="/photo" onerror="this.style.display='none'"><h2>${w.name}</h2><p>${w.phone} · <b>${st.status}</b></p>
${st.code ? `<p>קוד צימוד: <b style="font-size:30px;letter-spacing:4px">${st.code}</b></p>` : ''}
${st.qr ? `<img src="${st.qr}" width="300"><p>בפלאפון של ${w.name}: ווצאפ ← הגדרות ← מכשירים מקושרים ← קישור מכשיר ← לסרוק.</p><form method="post" action="/code"><button>אי אפשר לסרוק? קבל קוד במקום</button></form>` : ''}
</div></html>`))
app.get('/photo', (req, res) => (photo && fs.existsSync(photo) ? res.sendFile(photo) : res.sendStatus(404)))
app.post('/code', async (req, res) => {
  try { if (st.qr) st.code = await st.sock.requestPairingCode(w.phone) } catch (e) { st.status = 'קוד נכשל: ' + e.message }
  res.redirect('/')
})
app.listen(PORT, '127.0.0.1', () => console.log(`לפתוח: http://localhost:${PORT}  (${w.name})`))
start()
