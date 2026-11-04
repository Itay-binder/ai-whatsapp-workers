// מדיה נכנסת לעובדים: הורדה, שמירה מקומית, ותמלול מקומי (transcribe.js: ffmpeg + whisper.cpp, בלי שירות בתשלום).
// כל העובדים רצים באותו תהליך, לכן הודעה אחת בקבוצה מורדת ומתומללת פעם אחת בלבד (מטמון לפי מזהה ההודעה).
import { downloadMediaMessage } from '@whiskeysockets/baileys'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { transcribeFile } from './transcribe.js'

const DIR = path.dirname(fileURLToPath(import.meta.url))
let MEDIA_DIR = path.join(DIR, '..', 'media')
let WHISPER = {}
// נקרא פעם אחת מ-index.js עם ההגדרות מ-workers.json
export function initMedia({ mediaDir, whisper } = {}) {
  if (mediaDir) MEDIA_DIR = mediaDir
  WHISPER = whisper || {}
}

const EXT = { 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/webm': 'webm', 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'text/plain': 'txt', 'application/pdf': 'pdf' }
const TEXT_EXT = /\.(txt|srt|vtt|md|csv|json|docx?|pdf|rtf)$/i

// מה יש בהודעה: kind = voice | audio | video | text-file | null
export function mediaOf(msg) {
  const m = msg?.message || {}
  const inner = m.ephemeralMessage?.message || m.viewOnceMessage?.message || m.viewOnceMessageV2?.message || m.documentWithCaptionMessage?.message || m
  const pick = (k, kind) => inner[k] && { kind, key: k, node: inner[k], mimetype: inner[k].mimetype || '', seconds: inner[k].seconds || 0, fileName: inner[k].fileName || '', caption: inner[k].caption || '' }
  const a = pick('audioMessage', inner.audioMessage?.ptt ? 'voice' : 'audio') || pick('videoMessage', 'video') || pick('ptvMessage', 'video')
  if (a) return { ...a, forwarded: !!a.node.contextInfo?.isForwarded }
  const d = inner.documentMessage
  if (d) {
    const mt = d.mimetype || '', fn = d.fileName || ''
    const kind = mt.startsWith('audio/') ? 'audio' : mt.startsWith('video/') ? 'video' : (mt.startsWith('text/') || TEXT_EXT.test(fn) || /word|pdf|rtf/.test(mt)) ? 'text-file' : null
    if (kind) return { kind, key: 'documentMessage', node: d, mimetype: mt, seconds: 0, fileName: fn, caption: d.caption || '', forwarded: !!d.contextInfo?.isForwarded }
  }
  return null
}

// ---------- שמירה ----------
const saved = new Map() // msgId -> Promise<path>
export function saveMedia(msg, sock, media) {
  const id = msg.key.id
  if (!saved.has(id)) saved.set(id, (async () => {
    fs.mkdirSync(MEDIA_DIR, { recursive: true })
    const ext = (media.fileName.match(/\.([a-z0-9]{1,5})$/i)?.[1]) || EXT[media.mimetype.split(';')[0]] || 'bin'
    const day = new Date().toISOString().slice(0, 10)
    const base = media.fileName ? media.fileName.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) + '-' : ''
    const file = path.join(MEDIA_DIR, `${day}-${base}${id}.${ext}`)
    if (!fs.existsSync(file)) {
      const buf = await downloadMediaMessage(msg, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage })
      fs.writeFileSync(file, buf)
    }
    return file
  })().catch(e => { saved.delete(id); throw e }))
  return saved.get(id)
}

// ---------- תמלול: עבודה אחת בכל פעם (המעבד עמוס), תור לפי אורך (קצר קודם) ----------
const queue = []           // {file, seconds, resolve, reject}
let busy = false

function next() {
  if (busy || !queue.length) return
  queue.sort((a, b) => a.seconds - b.seconds)
  const job = queue.shift(); busy = true
  transcribeFile(WHISPER, job.file, job.seconds)
    .then(job.resolve, job.reject)
    .finally(() => { busy = false; next() })
}
function runTranscribe(file, seconds) {
  return new Promise((resolve, reject) => { queue.push({ file, seconds, resolve, reject }); next() })
}

// הורדה + תמלול, פעם אחת לכל הודעה. התמלול נשמר גם כקובץ txt ליד ההקלטה.
const transcripts = new Map() // msgId -> Promise<{text, lang, sec, file, txt}>
export function transcribeMsg(msg, sock, media) {
  const id = msg.key.id
  if (!transcripts.has(id)) transcripts.set(id, (async () => {
    const file = await saveMedia(msg, sock, media)
    const txt = file.replace(/\.[^.]+$/, '.txt')
    if (fs.existsSync(txt)) return { text: fs.readFileSync(txt, 'utf8'), file, txt }
    const t0 = Date.now()
    const r = await runTranscribe(file, media.seconds || 60)
    fs.writeFileSync(txt, r.text)
    console.log(`[תמלול] ${path.basename(file)}: ${r.sec} שניות, ${r.lang}, ${Math.round((Date.now() - t0) / 1000)} שניות עבודה`)
    return { ...r, file, txt }
  })().catch(e => { transcripts.delete(id); throw e }))
  return transcripts.get(id)
}

// תמלול קיים לפי מזהה הודעה (כשהבעלים מגיב להקלטה שכבר תומללה)
export function transcriptById(id) {
  if (transcripts.has(id)) return transcripts.get(id)
  if (!fs.existsSync(MEDIA_DIR)) return null
  const f = fs.readdirSync(MEDIA_DIR).find(n => n.endsWith(`${id}.txt`))
  return f ? Promise.resolve({ text: fs.readFileSync(path.join(MEDIA_DIR, f), 'utf8'), txt: path.join(MEDIA_DIR, f) }) : null
}
