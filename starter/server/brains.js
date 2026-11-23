// בחירת מנוע המוח של עובד. השדה engine ב-workers.json (לכל עובד, או ברמה הכללית). ברירת מחדל: claude.
//
// ממשק שכל מנוע חייב לממש (createBrain(opts) מחזיר אובייקט):
//   ask(chat, text, taint)  להוסיף הודעה לתור. chat = לאן לשלוח את התשובה. taint = ההודעה כוללת תוכן שלא כתב הבעלים.
//   reset(why)              שיחה חדשה (מוחק את הסשן של היום)
//   close()                 לעצור
//   busy()                  האם יש תור פתוח
// ומקבל ב-opts (ראו brain.js): cwd, workerDir, allowedDirs, rolePrompt, mode, enforceScope, port, ownerIds,
//   countryCode, mediaDir, preApproved, ownerName, workerLabel, timezone, ו-callbacks:
//   onReply(chat, text), onTyping(chat), onApproval(chat, tool, input) => Promise<boolean>, log(text).
//
// מדיניות ההרשאות (policy.js) לא תלויה במנוע. מנוע חדש חייב להריץ לפני כל כלי את אותו סדר בדיקות כמו ב-brain.js:
//   bringsForeignContent → dangerousUnderTaint → outOfScope (אם enforceScope) → classify → trusted/approve.
// אם המנוע לא מאפשר hook לפני כל כלי, אסור לחבר אותו במצב trusted.
import { createBrain as createClaudeBrain } from './brain.js'

const ENGINES = {
  claude: createClaudeBrain,
  // TODO(codex): מנוע Codex (OpenAI Codex CLI / SDK). מה צריך:
  //   1. קובץ brain-codex.js שמממש את הממשק למעלה, עם סשן יומי ב-state/session-codex.json.
  //   2. חיבור של policy.js לכל קריאת כלי (approval hook / sandbox policy של Codex), כולל חסימת תוכן זר.
  //   3. טעינת ROLE.md כהוראות מערכת, והתאמת הסקילים (first-run, connect-system) לקריאה ישירה מהקובץ.
  //   4. ב-install: התקנת Codex CLI והתחברות. עד אז engine: "codex" נכשל עם הודעה ברורה.
  codex: () => { throw new Error('מנוע Codex עוד לא מומש. להשתמש ב-engine: "claude" (ראו TODO ב-server/brains.js)') },
}

export function createWorkerBrain(engine = 'claude', opts) {
  const make = ENGINES[engine]
  if (!make) throw new Error(`מנוע מוח לא מוכר: ${engine}. אפשרויות: ${Object.keys(ENGINES).join(', ')}`)
  return make(opts)
}
