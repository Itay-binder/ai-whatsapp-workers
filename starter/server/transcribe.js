// תמלול הקלטות מקומית: ffmpeg (כל פורמט, כולל ogg/opus של ווצאפ ווידאו → wav 16k מונו) + whisper.cpp.
// הגדרות ב-workers.json תחת "whisper": { exe, model, ffmpeg, lang }. ריק = ברירות המחדל למטה.
// lang: "he" לעברית (ברירת מחדל), או "auto" לזיהוי שפה אוטומטי.
import { execFile } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

const run = (cmd, args, timeout) => new Promise((resolve, reject) =>
  execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => err ? reject(new Error((stderr || err.message).slice(-400))) : resolve(stdout)))

export function whisperConfig(w = {}) {
  const home = os.homedir()
  const win = process.platform === 'win32'
  const localExe = path.join(home, 'tools', 'whisper', 'Release', win ? 'whisper-cli.exe' : 'whisper-cli')
  return {
    // ברירת מחדל: מה ש-install-whisper.ps1 מתקין. ב-Mac/Linux: whisper-cli מה-PATH (למשל brew install whisper-cpp)
    exe: w.exe || (fs.existsSync(localExe) ? localExe : 'whisper-cli'),
    model: w.model || path.join(home, 'tools', 'whisper', 'models', 'ggml-large-v3-turbo-q5_0.bin'),
    // winget מתקין קיצור כאן. נתיב מלא = עובד גם כשה-PATH של משימה מתוזמנת ישן
    ffmpeg: w.ffmpeg || [path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe')].find(p => win && fs.existsSync(p)) || 'ffmpeg',
    lang: w.lang || 'he',
  }
}

// מתמלל קובץ שמע/וידאו. מחזיר { text, lang, sec }
export async function transcribeFile(w, file, seconds = 60) {
  const c = whisperConfig(w)
  if (!fs.existsSync(c.model)) throw new Error(`לא נמצא מודל whisper ב-${c.model}. להריץ install-whisper.ps1 או להגדיר whisper.model ב-workers.json`)
  const base = file.replace(/\.[^.]+$/, '') + '.whisper'
  const wav = base + '.wav'
  try {
    await run(c.ffmpeg, ['-y', '-loglevel', 'error', '-i', file, '-vn', '-ar', '16000', '-ac', '1', wav], 5 * 60000)
    const sec = Math.round(Math.max(0, fs.statSync(wav).size - 44) / 32000 * 10) / 10
    if (sec < 0.3) return { text: '', lang: c.lang, sec }
    const threads = String(Math.max(2, Math.min(16, os.cpus().length - 2)))
    // זמן מקסימלי לפי אורך ההקלטה (על מעבד: בערך פי 1 מאורך ההקלטה, עם מרווח)
    const timeout = Math.max(5 * 60000, (seconds || sec) * 3 * 1000)
    await run(c.exe, ['-m', c.model, '-l', c.lang, '-t', threads, '-nt', '-otxt', '-of', base, '-f', wav], timeout)
    const text = fs.readFileSync(base + '.txt', 'utf8').replace(/\s+/g, ' ').trim()
    return { text, lang: c.lang, sec }
  } finally {
    for (const f of [wav, base + '.txt']) fs.rmSync(f, { force: true })
  }
}
