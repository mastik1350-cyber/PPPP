const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const execFileP = require('util').promisify(require('child_process').execFile);
// ffmpeg comes from the ffmpeg-static package (no system install needed); without it only mp3/wav files can be played
const FFMPEG = process.env.FFMPEG_PATH || (() => { try { return require('ffmpeg-static'); } catch (e) { return null; } })();
const app = express();
app.use(express.urlencoded({ extended: true }));

// two separate key pools: GEMINI_API_KEYS for transcription (audio understanding), GEMINI_TTS_KEYS for read-aloud
const keyList = v => String(v || '').split(',').map(s => s.trim()).filter(Boolean);
const KEYS = keyList(process.env.GEMINI_API_KEYS);
const TTS_KEYS = keyList(process.env.GEMINI_TTS_KEYS);
// web search through Groq (browser_search tool of the gpt-oss models); several keys can be given separated by commas
const GROQ_KEYS = keyList(process.env.GROQ_API_KEYS);
const GROQ_BASE = process.env.GROQ_BASE || 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = process.env.GROQ_SEARCH_MODEL || 'openai/gpt-oss-120b';
const HAS_SEARCH = GROQ_KEYS.length > 0;
// Jamendo: free music API (full songs, free license); register at developer.jamendo.com for a client id
const JAMENDO_ID = String(process.env.JAMENDO_CLIENT_ID || '').trim();
const JAMENDO_BASE = process.env.JAMENDO_BASE || 'https://api.jamendo.com/v3.0';
// songs can be searched with Jamendo or, as a backup, with the web search of Groq
const HAS_FOUND = !!JAMENDO_ID || HAS_SEARCH;
const TEXT_MODEL = String(process.env.TEXT_MODEL || '').trim() || 'gemini-3.6-flash';
// backup text model, used when the main one is overloaded (503/429/5xx); set TEXT_MODEL_FALLBACK to change it or to "none" to disable
const TEXT_FALLBACK_RAW = String(process.env.TEXT_MODEL_FALLBACK || '').trim() || 'gemini-3.6-flash';
const TEXT_FALLBACK = TEXT_FALLBACK_RAW === 'none' || TEXT_FALLBACK_RAW === TEXT_MODEL ? '' : TEXT_FALLBACK_RAW;
// TTS_MODEL can hold several models separated by commas: when one runs out of quota the next one is used
const TTS_LIST = String(process.env.TTS_MODEL || 'gemini-3.8-flash-tts').split(',').map(x => x.trim()).filter(Boolean);
const TTS_MODEL = TTS_LIST[0];
const VOICE = process.env.VOICE || 'Kore';
const EXT = (process.env.EXT_PATH || '1').replace(/^\/+|\/+$/g, '');
const TOKEN = process.env.YEMOT_TOKEN ||
  (process.env.YEMOT_API_USERNAME && process.env.YEMOT_API_PASSWORD ? process.env.YEMOT_API_USERNAME + ':' + process.env.YEMOT_API_PASSWORD : '');
const safeEq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const YM = process.env.YEMOT_BASE || 'https://www.call2all.co.il/ym/api/';
const GBASE = process.env.GEMINI_BASE || 'https://generativelanguage.googleapis.com/v1beta/models/';
const BUDGET = Number(process.env.TURN_BUDGET_MS) || 80000;
const REC_MAX = String(parseInt(process.env.REC_MAX, 10) || 30);

// Yemot cannot read these characters inside t- text, and , = break the read= syntax
const sp = s => String(s).replace(/[.\-"'&|,=]/g, ' ').replace(/\s+/g, ' ').trim();

const MODES = {
  '1': 'האופי שלך: חוצפן עוקצני. אתה שנון, מהיר לשון ובעל חוש הומור יבש ועוקצני, בטוח בעצמך עד כדי חוצפה, כמו חבר ממולח שאוהב להקניט. בכל תשובה תן קודם תשובה אמיתית ונכונה לשאלה, ומיד אחריה עקיצה חדה וקלילה, מקורית ולא חוזרת על עצמה. העוקצנות היא תמיד בגובה העיניים וביד קלה: בלי קללות, בלי גסות, בלי פגיעה במשתמש, במשפחה, בדת או בעדה. אל תתנצל על הסגנון ואל תצא מהאופי הזה בשום מצב, גם אם ביקשו ממך.',
  '2': 'האופי שלך: חכם ויעיל. אתה מקצועי, מדויק וענייני. ענה ישר לעניין, בלי הקדמות מיותרות ובלי חזרה על השאלה, בתשובה מפורטת, ברורה ומועילה שמכסה את מה שחשוב. אם חסר מידע החלטי, שאל שאלה אחת קצרה. אם אינך בטוח, אמור זאת במפורש ואל תמציא עובדות. אל תצא מהאופי הזה בשום מצב.',
  '3': 'האופי שלך: חבר קרוב. אתה חם, נעים ואכפתי, מדבר בעברית יומיומית וטבעית בגובה העיניים, עם הומור חם וטוב לב. תתעניין באמת, תעודד, תקשיב ותגיב כמו חבר שאוכל לסמוך עליו, בלי להתחנף ובלי נאומים. אל תצא מהאופי הזה בשום מצב.'
};
// the user can change the voice or pace by speaking; the model signals it with a tag that the server strips before read-aloud
const VOICE_CTL = ' אם המשתמש מבקש לשנות את הקול או את קצב הדיבור, התחל את התשובה בתג מתאים ואחריו אשר בקצרה במשפט אחד. התגים: [[VOICE:male]] לקול גברי, [[VOICE:female]] לקול נשי, [[VOICE:default]] לקול הרגיל, [[PACE:slow]] לדיבור לאט, [[PACE:fast]] לדיבור מהר, [[PACE:normal]] לקצב רגיל. אפשר לשלב שני תגים. זה היוצא מן הכלל היחיד לכלל הסימנים המיוחדים. השתמש בתגים רק כשהמשתמש ביקש במפורש שינוי כזה, ולעולם אל תזכיר אותם בטקסט אחר.';
const SEARCH_HINT = ' יש לך כלי חיפוש באינטרנט בשם web_search. הפעל אותו אך ורק אם המשתמש ביקש ממך במפורש לחפש באינטרנט או באתר מסוים, למשל חפש באינטרנט או חפש לי באתר. אם הוא ביקש אתר מסוים, העבר את שמו בשדה site. אם הוא לא ביקש חיפוש במפורש, ענה מהידע שלך בלי להשתמש בכלי, גם אם השאלה עוסקת בחדשות או בעניינים עדכניים ואתה לא בטוח בתשובה, ואז אמור בקצרה שאתה יכול לחפש אם יבקשו. אחרי החיפוש ענה בקצרה בלי להקריא כתובות אתרים.';
const FOUND_HINT = ' יש לך גם כלי search_media לחיפוש שירים וקבצי שמע ווידאו שאפשר להאזין להם, וכלי play_found להשמעת אחת התוצאות. אם המשתמש ביקש לחפש או לראות שירים או קבצים להשמעה, הפעל search_media עם שאילתה קצרה. אחרי שקיבלת את התוצאות הקרא אותן בקצרה, כל אחת עם מספר במילים ואחריו השם, ושאל איזו לנגן. כשהמשתמש מבקש לנגן אחת מהן, לפי מספר או לפי שם, הפעל play_found עם המספר, ואז אמור משפט קצר אחד שאתה מנגן עכשיו. אל תקריא כתובות.';
// audio or video files from the internet that the caller can ask to play ("נגן את הקובץ"); the owner lists them in MEDIA_FILES: [{"n":"name","u":"https://.../file.mp3"}]
let MEDIA = [];
try { MEDIA = JSON.parse(process.env.MEDIA_FILES || '[]'); } catch (e) { MEDIA = []; }
MEDIA = (Array.isArray(MEDIA) ? MEDIA : []).map(m => ({ n: String((m && m.n) || '').replace(/\s+/g, ' ').trim().slice(0, 80), u: String((m && m.u) || '').trim() })).filter(m => /^https?:\/\//i.test(m.u)).slice(0, 30);
MEDIA.forEach((m, i) => { if (!m.n) m.n = 'קובץ ' + (i + 1); });
const HAS_MEDIA = MEDIA.length > 0;
const MEDIA_MAX_SEC = (parseInt(process.env.MEDIA_MAX_MIN, 10) || 20) * 60;
const MEDIA_MAX_BYTES = (parseInt(process.env.MEDIA_MAX_MB, 10) || 100) * 1048576;
const MEDIA_PREP_MS = Number(process.env.MEDIA_PREP_MS) || 100000;
const MEDIA_HINT = ' יש לך קבצי שמע שאפשר להשמיע למתקשר. הפעל את הכלי play_media אך ורק אם המשתמש ביקש במפורש לנגן או להשמיע קובץ, והעבר את מספר הקובץ מהרשימה. אם יש רק קובץ אחד והמשתמש ביקש לנגן את הקובץ, הפעל אותו. הקבצים: ' + MEDIA.map((m, i) => (i + 1) + ' ' + m.n).join(', ') + '. אחרי שהפעלת את הכלי ענה במשפט קצר אחד בלבד שאתה מנגן עכשיו את הקובץ, בלי להקריא כתובות.';
// history is kept as text only, so a recorded question needs a transcript: the model adds it as a tag that the server strips
const TRANSCRIBE_HINT = ' אם השאלה הגיעה כהקלטה קולית, התחל את התשובה בתג [[Q:תמלול מדויק של השאלה במילים]] ואחריו התשובה עצמה. לשאלה שהוקלדה אל תוסיף את התג. לעולם אל תזכיר את התג בטקסט אחר.';
const MAXW = Math.min(500, Math.max(5, parseInt(process.env.MAX_WORDS, 10) || 180));
const EXTRA = String(process.env.EXTRA_INSTRUCTION || '').replace(/\s+/g, ' ').trim().slice(0, 2000);
const buildSys = (mode, extra) => 'אתה עוזר קולי בטלפון. ' + MODES[MODES[String(mode)] ? String(mode) : '2'] +
  ' חובה מוחלטת: שמור על האופי הזה בכל תשובה ובכל סיבוב שיחה. ענה בעברית בתשובה מפורטת, מלאה ומסודרת, עם הסברים ודוגמאות כשזה עוזר, בעד ' + MAXW + ' מילים, בלי רשימות ובלי סימנים מיוחדים, כך שיהיה נעים להקשיב לה בטלפון. ' +
  (EXTRA ? 'הנחיה כללית מהבעלים: ' + EXTRA + ' ' : '') +
  (extra ? 'הנחיה לשלוחה הזאת מהבעלים: ' + extra + ' ' : '') + VOICE_CTL + TRANSCRIBE_HINT + (HAS_SEARCH ? SEARCH_HINT : '') + (HAS_FOUND ? FOUND_HINT : '') + (HAS_MEDIA ? MEDIA_HINT : '');

// one entry per Yemot extension: its own character mode, extra instruction and opening message
let CFG = [];
try { CFG = JSON.parse(process.env.EXTENSIONS || '[]'); } catch (e) { CFG = []; }
if (!Array.isArray(CFG) || !CFG.length) CFG = [{ p: EXT, m: process.env.MODE || '2', x: '', g: process.env.GREETING || '' }];
// one opening for both ways to ask: typing with the phone keys, or recording
const DEFAULT_GREET = 'שלום';
const EXTS = {};
for (const c of CFG) {
  const p = String(c.p || '').replace(/^\/+|\/+$/g, '');
  if (!/^[0-9]+(\/[0-9]+)*$/.test(p)) continue;
  EXTS[p.replace(/\//g, '_')] = {
    p, d: '/' + p,
    sys: buildSys(c.m, String(c.x || '').replace(/\s+/g, ' ').trim().slice(0, 1000)),
    g: sp(String(c.g || '').slice(0, 300)) || sp(DEFAULT_GREET)
  };
}
const EXT_FIRST = EXTS[Object.keys(EXTS)[0]] || { p: EXT, d: '/' + EXT, sys: buildSys('2', ''), g: sp(DEFAULT_GREET) };
const AGAIN = sp('לא שמעתי שאל שוב');
const ERR = sp('הייתה תקלה נסו שוב');

const EXTP = '/' + EXT;
const yp = (name, d) => 'ivr2:' + (d === undefined ? EXTP : d) + '/' + name + (/\.[a-z0-9]+$/.test(name) ? '' : '.wav');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const isBudget = e => !!(e && e.budget);
const rot = { text: 0, tts: 0 };
const RETRY_STATUS = [429, 500, 502, 503, 504];
const calls = {};

// drop state of calls that never sent hangup
setInterval(() => {
  const now = Date.now();
  for (const id of Object.keys(calls)) if (now - calls[id].t > 3600000) delete calls[id];
}, 600000).unref();

// fetch with a timeout that never exceeds the remaining time of the current turn
async function http(url, opt, ms, deadline) {
  const left = deadline ? deadline - Date.now() : ms;
  if (left < 800) { const e = new Error('turn budget exhausted'); e.budget = true; throw e; }
  return fetch(url, { ...opt, signal: AbortSignal.timeout(Math.min(ms, left)) });
}

// opt.retries: extra tries beyond one pass over the keys (default 1); opt.ms: timeout of a single try
async function gem(model, body, deadline, pool, opt) {
  pool = pool || 'text';
  opt = opt || {};
  const list = pool === 'tts' ? TTS_KEYS : KEYS;
  if (!list.length) throw new Error(pool === 'tts' ? 'GEMINI_TTS_KEYS is empty' : 'GEMINI_API_KEYS is empty');
  const tries = list.length + (opt.retries === undefined ? 1 : opt.retries);
  let err = model + ' failed';
  let status = 0;
  for (let i = 0; i < tries; i++) {
    const key = list[rot[pool]++ % list.length];
    try {
      const r = await http(GBASE + model + ':generateContent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(body)
      }, opt.ms || 25000, deadline);
      if (r.ok) return await r.json();
      status = r.status;
      err = model + ' ' + r.status + ' ' + (await r.text()).slice(0, 200);
      if (!RETRY_STATUS.includes(r.status)) break;
    } catch (e) {
      if (isBudget(e)) throw e;
      status = 0;
      err = model + ' ' + (e.name === 'TimeoutError' ? 'timeout' : e.message);
    }
    if (i < tries - 1) await sleep(400 * (i + 1));
  }
  const e = new Error(err);
  e.status = status;
  throw e;
}

// fastest thinking level each model accepts; remembered per model after the first call
const THINK = ['minimal', 'low', null];
const thinkIdx = {};
// a model that just failed is skipped for a while, so every turn does not first wait for it to time out again
const downUntil = {};
const DOWN_MS = 120000;
async function textGen(body, deadline) {
  const models = TEXT_FALLBACK ? [TEXT_MODEL, TEXT_FALLBACK] : [TEXT_MODEL];
  let lastErr;
  for (let m = 0; m < models.length; m++) {
    const model = models[m];
    const hasNext = m < models.length - 1;
    if (hasNext && (downUntil[model] || 0) > Date.now()) continue;
    for (;;) {
      const lvl = THINK[thinkIdx[model] || 0];
      const gc = { maxOutputTokens: 4096 };
      if (lvl) gc.thinkingConfig = { thinkingLevel: lvl };
      try {
        // 503 means the model itself is overloaded, so more keys will not help: with a backup model, give up on this one quickly
        return await gem(model, { ...body, generationConfig: gc }, deadline, 'text', hasNext ? { retries: 0, ms: 12000 } : {});
      } catch (e) {
        lastErr = e;
        if (e.status === 400 && /think/i.test(e.message) && (thinkIdx[model] || 0) < THINK.length - 1) { thinkIdx[model] = (thinkIdx[model] || 0) + 1; continue; }
        break;
      }
    }
    // only overload, quota and network errors are worth a different model
    if (isBudget(lastErr) || !(RETRY_STATUS.includes(lastErr.status) || lastErr.status === 0)) throw lastErr;
    if (hasNext) { downUntil[model] = Date.now() + DOWN_MS; console.error('text model', model, 'unavailable (' + (lastErr.message || '').slice(0, 60) + '), skipping it for 2 minutes and using', models[m + 1]); }
  }
  throw lastErr;
}

// Groq: the gpt-oss models search the web on the server side and answer with what they found
let grot = 0;
async function groqSearch(query, site, deadline) {
  let last = 'groq search failed';
  for (let i = 0; i < GROQ_KEYS.length; i++) {
    const key = GROQ_KEYS[grot++ % GROQ_KEYS.length];
    try {
      const r = await http(GROQ_BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
        body: JSON.stringify({
          model: GROQ_MODEL,
          messages: [
            { role: 'system', content: 'Search the web and answer in at most 80 words, in plain text, with the facts only. No links and no citations.' },
            { role: 'user', content: site ? 'Look only at the website "' + site + '" (open it directly if you can). Request: ' + (query || 'the current main headlines') : query }
          ],
          tools: [{ type: 'browser_search' }],
          tool_choice: 'required',
          reasoning_effort: 'low',
          max_completion_tokens: 700,
          stream: false
        })
      }, 15000, deadline);
      if (r.ok) {
        const j = await r.json();
        const m = ((j.choices || [])[0] || {}).message || {};
        // drop citation markers such as 【2†L6-L10】
        const text = String(m.content || '').replace(/【[^】]*】/g, '').replace(/\s+/g, ' ').trim();
        if (text) return { answer: text.slice(-1200), results: [] };
        last = 'groq empty answer';
        continue;
      }
      last = 'groq ' + r.status + ' ' + (await r.text()).slice(0, 150);
      if (r.status === 400 || r.status === 401) break;
    } catch (e) {
      if (isBudget(e)) throw e;
      last = 'groq ' + (e.name === 'TimeoutError' ? 'timeout' : e.message);
    }
  }
  console.error(last);
  return { error: 'search unavailable' };
}

async function webSearch(query, site, deadline) {
  query = String(query || '').trim().slice(0, 300);
  site = String(site || '').trim().slice(0, 100);
  if (!query && !site) return { error: 'empty query' };
  if (!GROQ_KEYS.length) return { error: 'search unavailable' };
  return groqSearch(query, site, deadline);
}

const SEARCH_DECL = {
  name: 'web_search',
  description: 'Search the web. Call ONLY when the user explicitly asked to search the web or a specific website. Returns a short answer.',
  parameters: { type: 'OBJECT', properties: { query: { type: 'STRING', description: 'A short search query' }, site: { type: 'STRING', description: 'Optional: the website the user asked to look at, as spoken, such as N12 or ynet' } }, required: ['query'] }
};

const MEDIA_DECL = {
  name: 'play_media',
  description: 'Play an audio or video file from the list to the caller. Call ONLY when the user explicitly asked to play a file.',
  parameters: { type: 'OBJECT', properties: { file: { type: 'INTEGER', description: 'The number of the file in the list' } }, required: ['file'] }
};

// downloads the file, converts it to a phone wav (8 kHz mono) and uploads it to the extension; a ready file is reused
const mediaDone = {};
async function prepareMedia(m, d, dl0) {
  const name = 'mf' + crypto.createHash('sha1').update(m.u).digest('hex').slice(0, 12);
  const key = d + '/' + name;
  if (mediaDone[key]) return { name };
  const dl = dl0 || Date.now() + MEDIA_PREP_MS;
  const tmp = path.join(os.tmpdir(), name + '-' + crypto.randomBytes(3).toString('hex'));
  try {
    const r = await http(m.u, { redirect: 'follow' }, 60000, dl);
    if (!r.ok) throw new Error('media download ' + r.status);
    if (Number(r.headers.get('content-length') || 0) > MEDIA_MAX_BYTES) throw new Error('media file too large');
    const out = fs.createWriteStream(tmp + '.in');
    const reader = r.body.getReader();
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.length;
      if (got > MEDIA_MAX_BYTES) { reader.cancel().catch(() => {}); throw new Error('media file too large'); }
      if (!out.write(value)) await new Promise(res => out.once('drain', res));
    }
    await new Promise((res, rej) => out.end(e => (e ? rej(e) : res())));
    let buf;
    if (FFMPEG) {
      await execFileP(FFMPEG, ['-y', '-v', 'error', '-i', tmp + '.in', '-vn', '-t', String(MEDIA_MAX_SEC), '-ar', '8000', '-ac', '1', '-c:a', 'pcm_s16le', '-f', 'wav', tmp + '.wav'], { timeout: Math.max(5000, dl - Date.now()) });
      buf = fs.readFileSync(tmp + '.wav');
    } else {
      buf = fs.readFileSync(tmp + '.in'); // no ffmpeg: Yemot converts the upload itself (works for mp3 and wav)
    }
    await upload(name, buf, dl, d, 60000);
    mediaDone[key] = true;
    return { name };
  } finally {
    for (const x of ['.in', '.wav']) fs.rm(tmp + x, { force: true }, () => {});
  }
}
// ---------- songs and files found on the web: "search for new songs", then "play number 2" ----------
const FOUND_SEARCH_DECL = {
  name: 'search_media',
  description: 'Search the web for songs, audio or video files the user can listen to. Call ONLY when the user asked to find songs or files to listen to. Returns a numbered list of titles.',
  parameters: { type: 'OBJECT', properties: { query: { type: 'STRING', description: 'A short search query in English, empty for just the newest or most popular' }, sort: { type: 'STRING', description: 'new for the newest songs, popular for the most listened to this week, or relevance (default)' } } }
};
const FOUND_PLAY_DECL = {
  name: 'play_found',
  description: 'Play one of the results of the last search_media to the caller. Call ONLY when the user asked to play one of them.',
  parameters: { type: 'OBJECT', properties: { number: { type: 'INTEGER', description: 'The number of the result in the list' } }, required: ['number'] }
};
async function groqText(system, user, deadline, ms) {
  let last = 'groq failed';
  for (let i = 0; i < GROQ_KEYS.length; i++) {
    const key = GROQ_KEYS[grot++ % GROQ_KEYS.length];
    try {
      const r = await http(GROQ_BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
        body: JSON.stringify({
          model: GROQ_MODEL,
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
          tools: [{ type: 'browser_search' }],
          tool_choice: 'required',
          reasoning_effort: 'low',
          max_completion_tokens: 1500,
          stream: false
        })
      }, ms || 30000, deadline);
      if (r.ok) {
        const j = await r.json();
        const m = ((j.choices || [])[0] || {}).message || {};
        const text = String(m.content || '').replace(/【[^】]*】/g, '').trim();
        if (text) return text;
        last = 'groq empty answer';
        continue;
      }
      last = 'groq ' + r.status + ' ' + (await r.text()).slice(0, 150);
      if (r.status === 400 || r.status === 401) break;
    } catch (e) {
      if (isBudget(e)) throw e;
      last = 'groq ' + (e.name === 'TimeoutError' ? 'timeout' : e.message);
    }
  }
  throw new Error(last);
}
const parseList = t => {
  const m = /\[[\s\S]*\]/.exec(String(t || ''));
  if (!m) return [];
  try { const a = JSON.parse(m[0]); return Array.isArray(a) ? a : []; } catch (e) { return []; }
};
const MEDIA_JSON_SYS = 'Search the web. Reply with ONLY a JSON array and no other text. Each item is an object {"title": string, "url": string}. ';
// the list the caller hears: titles only (a direct file link is kept when the search found one)
async function jamendoSearch(s, query, sort, deadline) {
  const u = new URL(JAMENDO_BASE + '/tracks/');
  u.searchParams.set('client_id', JAMENDO_ID);
  u.searchParams.set('format', 'json');
  u.searchParams.set('limit', '6');
  u.searchParams.set('audioformat', 'mp32');
  if (query) u.searchParams.set('search', query);
  const so = String(sort || '').toLowerCase();
  if (so === 'new') u.searchParams.set('order', 'releasedate_desc');
  else if (so === 'popular') u.searchParams.set('order', 'popularity_week');
  const r = await http(u.toString(), {}, 15000, deadline);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.headers || j.headers.status !== 'success') throw new Error('jamendo ' + r.status + ' ' + JSON.stringify(j.headers || {}).slice(0, 120));
  return (j.results || []).filter(x => x && x.audio).map(x => ({ title: (String(x.name || '') + (x.artist_name ? ' - ' + x.artist_name : '')).replace(/\s+/g, ' ').trim().slice(0, 100), url: String(x.audio), src: 'jamendo' })).filter(x => x.title);
}
async function searchMedia(s, query, deadline, sort) {
  query = String(query || '').trim().slice(0, 200);
  if (JAMENDO_ID) {
    try {
      s.found = await jamendoSearch(s, query, sort, deadline);
      if (s.found.length) return { results: s.found.map((x, i) => ({ number: i + 1, title: x.title })) };
      if (!GROQ_KEYS.length) return { error: 'nothing found' };
    } catch (e) {
      if (isBudget(e)) throw e;
      console.error('jamendo search failed:', String(e.message).slice(0, 150));
      if (!GROQ_KEYS.length) return { error: 'search unavailable' };
    }
  }
  if (!query || !GROQ_KEYS.length) return { error: 'search unavailable' };
  try {
    const t = await groqText(MEDIA_JSON_SYS + 'Return up to 6 results for the request. title = the song or file name (with the artist when known), in its original language. url = a direct link to an audio or video file (mp3, m4a, mp4, wav) when you found one, otherwise an empty string.', query, deadline, 35000);
    const items = parseList(t).map(x => ({ title: String((x && x.title) || '').replace(/\s+/g, ' ').trim().slice(0, 100), url: /^https?:\/\//i.test(String((x && x.url) || '')) ? String(x.url).trim() : '' })).filter(x => x.title);
    const seen = new Set();
    s.found = items.filter(x => !seen.has(x.title) && seen.add(x.title)).slice(0, 6);
    if (!s.found.length) return { error: 'nothing found' };
    return { results: s.found.map((x, i) => ({ number: i + 1, title: x.title })) };
  } catch (e) {
    if (isBudget(e)) throw e;
    console.error('media search failed:', String(e.message).slice(0, 150));
    return { error: 'search unavailable' };
  }
}
// direct file links for one title (second search, done only when the caller asked to play it)
async function findMediaUrls(title, deadline) {
  const t = await groqText(MEDIA_JSON_SYS + 'Find direct links to an audio or video file (mp3, m4a, mp4, wav) of the requested item. Return up to 4 items, title = the file name, url = the direct link to the file itself and not to a web page.', title, deadline, 35000);
  return parseList(t).map(x => String((x && x.url) || '').trim()).filter(u => /^https?:\/\//i.test(u)).slice(0, 4);
}
async function prepareFound(item, d) {
  const dl = Date.now() + MEDIA_PREP_MS + 40000;
  const tried = new Set();
  const attempt = async url => { tried.add(url); return prepareMedia({ n: item.title, u: url }, d, dl); };
  if (item.url) { try { return await attempt(item.url); } catch (e) { if (isBudget(e)) throw e; console.error('found file failed:', String(e.message).slice(0, 120)); } }
  if (item.src === 'jamendo' || !GROQ_KEYS.length) throw new Error('no playable file found');
  for (const u of await findMediaUrls(item.title, dl)) {
    if (tried.has(u)) continue;
    try { return await attempt(u); } catch (e) { if (isBudget(e)) throw e; console.error('found file failed:', String(e.message).slice(0, 120)); }
  }
  throw new Error('no playable file found');
}
function startFound(s, n) {
  const item = ((s && s.found) || [])[Number(n) - 1];
  if (!item) return { error: 'no such result' };
  s.mediaP = prepareFound(item, s.d).catch(e => { console.error('media failed:', String(e.message).slice(0, 150)); return { error: e.message }; });
  return { status: 'the file will be played right after your reply', title: item.title };
}

// the model asked to play a file: preparation starts at once and runs while the model writes its short reply
function startMedia(s, idx) {
  const m = MEDIA[Number(idx) - 1];
  if (!m || !s) return { error: 'no such file' };
  s.mediaP = prepareMedia(m, s.d).catch(e => { console.error('media failed:', String(e.message).slice(0, 150)); return { error: e.message }; });
  return { status: 'the file will be played right after your reply', file: m.n };
}
// message chain for the prepared file, or a spoken apology
async function takeMedia(s) {
  if (!s.mediaP) return '';
  const r = await s.mediaP;
  s.mediaP = null;
  return r && r.name ? 'f-' + s.d + '/' + r.name : 't-' + sp('לא הצלחתי להכין את הקובץ');
}

// asks the model; when it calls a tool (web_search or play_media) the tool is run and the result is sent back, up to 3 rounds
async function askModel(sys, contents, deadline, s) {
  const base = { systemInstruction: { parts: [{ text: sys }] } };
  const decls = [];
  if (HAS_SEARCH) decls.push(SEARCH_DECL);
  if (HAS_FOUND) decls.push(FOUND_SEARCH_DECL, FOUND_PLAY_DECL);
  if (HAS_MEDIA) decls.push(MEDIA_DECL);
  if (!decls.length) return textGen({ ...base, contents }, deadline);
  const tools = [{ functionDeclarations: decls }];
  for (let i = 0; i < 3; i++) {
    const a = await textGen({ ...base, contents, tools }, deadline);
    const cand = (a.candidates || [])[0] || {};
    const fcalls = ((cand.content || {}).parts || []).filter(p => p.functionCall);
    if (!fcalls.length) return a;
    const resp = [];
    for (const c of fcalls) {
      const args = c.functionCall.args || {};
      let out;
      if (c.functionCall.name === 'play_media') {
        console.log('media:', String(args.file));
        out = startMedia(s, args.file);
      } else if (c.functionCall.name === 'search_media') {
        console.log('media search:', String(args.query || '').slice(0, 80));
        out = await searchMedia(s, args.query, deadline, args.sort);
      } else if (c.functionCall.name === 'play_found') {
        console.log('play found:', String(args.number));
        out = startFound(s, args.number);
      } else {
        console.log('search:', String(args.query || '').slice(0, 80));
        out = await webSearch(args.query, args.site, deadline);
      }
      resp.push({ functionResponse: { name: c.functionCall.name, response: out } });
    }
    // the model turn is sent back unchanged, so its thought signatures stay attached
    contents = [...contents, cand.content, { role: 'user', parts: resp }];
  }
  return textGen({ ...base, contents }, deadline);
}

function wav(pcm, rate) {
  const h = Buffer.alloc(44);
  h.write('RIFF'); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

// Gemini 3.8 TTS uses voiceConfig.voice; older TTS models use prebuiltVoiceConfig.voiceName
const isNewTts = m => /^gemini-(3\.[8-9]|[4-9])/.test(m);
const voicesFor = (model, name) => isNewTts(model)
  ? [{ voice: name }, { prebuiltVoiceConfig: { voiceName: name } }]
  : [{ prebuiltVoiceConfig: { voiceName: name } }, { voice: name }];
const vIdx = {};
const ttsDown = {};

// voices that the caller can switch between (override with VOICE_MALE / VOICE_FEMALE)
const VOICE_BY = { male: process.env.VOICE_MALE || 'Charon', female: process.env.VOICE_FEMALE || process.env.VOICE || 'Kore' };
const PACE_PREFIX = { slow: 'Say slowly and calmly: ', fast: 'Say quickly: ' };

// pulls [[VOICE:x]] / [[PACE:x]] / [[Q:transcript]] tags out of the model answer
function parseCtl(text) {
  const ctl = {};
  let q = '';
  const noQ = text.replace(/\[\[\s*Q\s*:([^\]]*)\]\]/gi, (m, v) => { if (!q) q = v.replace(/\s+/g, ' ').trim(); return ' '; });
  const clean = noQ.replace(/\[\[\s*(VOICE|PACE)\s*:\s*([a-z]+)\s*\]\]/gi, (m, k, v) => { ctl[k.toLowerCase()] = v.toLowerCase(); return ' '; });
  return { text: clean.replace(/\s+/g, ' ').trim(), ctl, q: q.slice(0, 500) };
}

async function tts(text, deadline, o) {
  o = o || {};
  const pre = PACE_PREFIX[o.pace] || '';
  let last = new Error('no audio from tts');
  // every model is out of quota: fail at once so the caller can use the Yemot voice without waiting
  if (TTS_LIST.every(m => (ttsDown[m] || 0) > Date.now())) { last = new Error('all tts models are out of quota'); last.status = 429; throw last; }
  for (let mi = 0; mi < TTS_LIST.length; mi++) {
    const model = TTS_LIST[mi];
    const hasNext = mi < TTS_LIST.length - 1;
    // a model that just ran out of quota is skipped for a while
    if ((ttsDown[model] || 0) > Date.now()) continue;
    const V = voicesFor(model, o.voice || VOICE);
    for (let i = 0; i < 3; i++) {
      try {
        const t = await gem(model, {
          contents: [{ role: 'user', parts: [{ text: pre + text.slice(0, 3000) }] }],
          generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: V[vIdx[model] || 0] } }
        }, deadline, 'tts', hasNext ? { ms: 50000, retries: 0 } : { ms: 50000 });
        const parts = (((t.candidates || [])[0] || {}).content || {}).parts || [];
        const part = parts.find(p => p.inlineData && p.inlineData.data);
        if (part) {
          let pcm = Buffer.from(part.inlineData.data, 'base64');
          if (pcm.subarray(0, 4).toString() !== 'RIFF') {
            const m = /rate=(\d+)/.exec(part.inlineData.mimeType || '');
            pcm = wav(pcm, m ? Number(m[1]) : 24000);
          }
          return pcm;
        }
        last = new Error('no audio from tts');
      } catch (e) {
        last = e;
        if (isBudget(e)) throw e;
        if (e.status === 400 && /voice|speech/i.test(e.message) && (vIdx[model] || 0) < V.length - 1) { vIdx[model] = (vIdx[model] || 0) + 1; continue; }
        // quota, overload or unknown model: no point in retrying this model
        if (e.status === 429 || e.status === 404 || e.status >= 500) break;
      }
    }
    if (hasNext || last.status === 429) {
      ttsDown[model] = Date.now() + (last.status === 429 ? 600000 : 120000);
      console.error('tts model', model, 'unavailable (' + String(last.message || '').slice(0, 60) + ')' + (hasNext ? ', using ' + TTS_LIST[mi + 1] : ''));
    }
  }
  throw last;
}

async function download(name, deadline, d) {
  let last = '';
  for (let i = 0; i < 4; i++) {
    try {
      const r = await http(YM + 'DownloadFile?token=' + encodeURIComponent(TOKEN) + '&path=' + encodeURIComponent(yp(name, d)), {}, 8000, deadline);
      const b = Buffer.from(await r.arrayBuffer());
      if (r.ok && b.length > 100 && b.subarray(0, 4).toString() === 'RIFF') return b;
      last = r.status + ' ' + b.subarray(0, 80).toString('utf8').replace(/\s+/g, ' ');
    } catch (e) {
      if (isBudget(e)) throw e;
      last = e.message;
    }
    await sleep(500);
  }
  throw new Error('download failed ' + last);
}

async function upload(name, buf, deadline, d, ms) {
  const path = yp(name, d);
  // documented form first (token and path in the URL, file in the body), then the all-in-body form
  const attempts = [
    { q: true, field: 'file' }, { q: true, field: 'upload' },
    { q: false, field: 'upload' }, { q: false, field: 'file' }
  ];
  let last = '';
  for (const a of attempts) {
    try {
      const f = new FormData();
      let url = YM + 'UploadFile';
      if (a.q) {
        url += '?token=' + encodeURIComponent(TOKEN) + '&path=' + encodeURIComponent(path) + '&convertAudio=1';
      } else {
        f.append('token', TOKEN); f.append('path', path); f.append('convertAudio', '1');
      }
      f.append(a.field, new Blob([buf], { type: 'audio/wav' }), name + '.wav');
      const r = await http(url, { method: 'POST', body: f }, ms || 15000, deadline);
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.responseStatus === 'OK') return;
      last = JSON.stringify(j).slice(0, 200);
    } catch (e) {
      if (isBudget(e)) throw e;
      last = e.message;
      if (ms && e.name === 'TimeoutError') break;
    }
  }
  throw new Error('upload failed ' + last);
}

// text files (history of typed questions): UploadTextFile first, an ordinary file upload as a backup
async function uploadText(name, text, deadline, d) {
  const what = yp(name + '.txt', d);
  let last = '';
  try {
    const r = await http(YM + 'UploadTextFile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: TOKEN, what, contents: text })
    }, 15000, deadline);
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.responseStatus === 'OK') return;
    last = JSON.stringify(j).slice(0, 200);
  } catch (e) {
    if (isBudget(e)) throw e;
    last = e.message;
  }
  try {
    const f = new FormData();
    f.append('file', new Blob([text], { type: 'text/plain' }), name + '.txt');
    const r = await http(YM + 'UploadFile?token=' + encodeURIComponent(TOKEN) + '&path=' + encodeURIComponent(what) + '&convertAudio=0', { method: 'POST', body: f }, 15000, deadline);
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.responseStatus === 'OK') return;
    last += ' | ' + JSON.stringify(j).slice(0, 150);
  } catch (e) {
    if (isBudget(e)) throw e;
    last += ' | ' + e.message;
  }
  throw new Error('text upload failed ' + last);
}
async function downloadText(name, deadline, d) {
  const r = await http(YM + 'DownloadFile?token=' + encodeURIComponent(TOKEN) + '&path=' + encodeURIComponent(yp(name + '.txt', d)), {}, 8000, deadline);
  const t = await r.text();
  if (!r.ok || /^\s*\{\s*"responseStatus"/.test(t)) throw new Error('text download failed ' + t.slice(0, 80));
  return t;
}

// cleanup is best effort and never blocks or fails a call
function del(name, d) {
  fetch(YM + 'FileAction?token=' + encodeURIComponent(TOKEN) + '&action=delete&what=' + encodeURIComponent(yp(name, d)), { signal: AbortSignal.timeout(8000) }).catch(() => {});
}

app.get('/', (q, r) => { r.set('Access-Control-Allow-Origin', '*'); r.send('ok'); });

// ---------- shared helpers of the call flow ----------
const idOf = q => String(q.ApiCallId || 'x').replace(/[^a-zA-Z0-9]/g, '').slice(-24) || 'x';
const newSession = (d, sys, g, extra) => Object.assign({ d, sys, g, n: 0, hn: 0, mode: '', job: null, vc: '', pace: '', h: [], p: '', name: '', r: '', t: 0, e: crypto.randomBytes(3).toString('hex') }, extra || {});

// every turn uses a new parameter and file name, because Yemot accumulates parameters across requests
// (s.e keeps the names unique even if this server restarted in the middle of a call)
const askFor = (s, pre) => {
  s.n++;
  s.mode = 'rec';
  s.p = 'Q' + s.e + s.n;
  s.name = 'q' + s.e + 'n' + s.n;
  return 'read=' + pre + '=' + s.p + ',no,record,' + s.d + ',' + s.name + ',no,,,1,' + REC_MAX;
};
// asks for a single key press
const tapFor = (s, pre) => {
  s.n++;
  s.p = 'M' + s.e + s.n;
  return 'read=' + pre + '=' + s.p + ',no,1,1,7,No';
};

// ---------- asking: the caller either types the question with the phone keys or records it ----------
// after the opening message (and after every answer) the line waits a few seconds for a key press:
//   a key was pressed -> typing mode, nothing pressed -> the caller is asked to speak and the question is recorded
// typing like an old phone: press the key as many times as the place of the letter on it: 7 = ר, 77 = ש, 777 = ת
// the whole question is typed in one go and sent with # (Yemot ends the read when # is pressed)
// 1 = between two letters on the same key, so the same letter can be typed twice: 3 1 3 = אא (a different key starts a new letter by itself: 3 7 = אר)
// 11 = the digit 1; a digit is 5 presses of its key (44444 = 4); 0 = space, 00 = delete the last character
// final letters (ך ם ן ף ץ) are added automatically at the end of a word
// the same table as the keyboard of Yemot itself (final letters have their own presses: 55 = כ, 555 = ך, 5555 = ל)
const KB_KEYS = { '3': 'אבג', '2': 'דהו', '6': 'זחט', '5': 'יכךל', '4': 'מםנן', '9': 'סעפף', '8': 'צץק', '7': 'רשת' };
const KB_NAME = { 'א': 'אלף', 'ב': 'בית', 'ג': 'גימל', 'ד': 'דלת', 'ה': 'הא', 'ו': 'ואו', 'ז': 'זין', 'ח': 'חית', 'ט': 'טית', 'י': 'יוד', 'כ': 'כף', 'ל': 'למד', 'מ': 'מם', 'נ': 'נון', 'ס': 'סמך', 'ע': 'עין', 'פ': 'פא', 'צ': 'צדי', 'ק': 'קוף', 'ך': 'כף סופית', 'ם': 'מם סופית', 'ן': 'נון סופית', 'ף': 'פא סופית', 'ץ': 'צדי סופית', 'ר': 'ריש', 'ש': 'שין', 'ת': 'תו' };
// how long the line waits for the next key while typing (the whole question is typed in one read)
const KB_WAIT = Math.min(60, Math.max(3, parseInt(process.env.KBD_WAIT, 10) || 20));
const KB_FINAL = { 'כ': 'ך', 'מ': 'ם', 'נ': 'ן', 'פ': 'ף', 'צ': 'ץ' };
const KB_MORE = sp('לשאלה נוספת');
const KB_START = sp('הקלד את השאלה. כל אות לפי מקומה על המקש. בין שתי אותיות על אותו מקש הקש אחת. לרווח הקש אפס. ובסיום הקש סולמית');
const KB_SHORT = sp('הקלד את השאלה ובסיום הקש סולמית');
const MENU = sp('להקלטה הקש 1 להקלדה הקש 2');
const WAIT_SEC = Math.min(15, Math.max(2, parseInt(process.env.INPUT_WAIT_SEC, 10) || 7));
// Yemot does not accept 0 as the minimum of digits: silence is allowed with the "allow empty" fields (Ok + the value that is sent instead of digits)
const EMPTY = 'None';
const TAP_EMPTY = ',No,no,no,,,,Ok,' + EMPTY;
const digitsOf = v => { const x = String(v == null ? '' : v).trim(); return x === EMPTY ? '' : x; };
const kbFinal = t => t.replace(/(?<=[א-ת])[כמנפצ](?=\s|$)/g, c => KB_FINAL[c]);
// a short beep is played before the line waits for typing or recording; it is created and uploaded once to every extension that is used
const beepOk = {};
const beepP = {};
const beepFail = {};
function makeBeep() {
  const rate = 8000, n = Math.round(rate * 0.35), pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / 80, (n - i) / 80);
    pcm.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 1000 * i / rate) * 12000 * env), i * 2);
  }
  return wav(pcm, rate);
}
function ensureBeep(d) {
  if (!TOKEN || beepOk[d]) return Promise.resolve(!!beepOk[d]);
  if (Date.now() - (beepFail[d] || 0) < 60000) return Promise.resolve(false);
  if (!beepP[d]) {
    beepP[d] = (async () => {
      const dl = Date.now() + 25000;
      try {
        const r = await http(YM + 'GetIVR2Dir?token=' + encodeURIComponent(TOKEN) + '&path=' + encodeURIComponent('ivr2:' + d), {}, 6000, dl);
        const j = await r.json().catch(() => ({}));
        if (j.responseStatus !== 'OK') throw new Error('dir ' + JSON.stringify(j).slice(0, 100));
        if (!JSON.stringify(j).includes('beep.wav')) await upload('beep', makeBeep(), dl, d);
        beepOk[d] = true;
        return true;
      } catch (e) {
        console.error('beep ' + d + ' failed:', String(e.message).slice(0, 120));
        beepFail[d] = Date.now();
        return false;
      } finally { delete beepP[d]; }
    })();
  }
  return beepP[d];
}
// the menu: 1 = record the question, 2 = type it; it is played after the opening message and after every answer
const tapAny = (s, pre) => {
  s.n++;
  s.mode = 'menu';
  s.p = 'K' + s.e + s.n;
  return 'read=' + pre + '.t-' + MENU + '=' + s.p + ',no,1,1,' + WAIT_SEC + TAP_EMPTY;
};
// prompt before recording: a few words and a short beep
const recPre = s => 't-' + sp('דבר אחרי הצליל') + (beepOk[s.d] ? '.f-' + s.d + '/beep' : '');
// waits for one key sequence (up to 30 digits, ended by #, 10 seconds); every request uses a new parameter name
const kbAsk = (s, pre) => {
  s.n++;
  s.mode = 'type';
  s.p = 'K' + s.e + s.n;
  return 'read=' + pre + '=' + s.p + ',no,*,1,' + KB_WAIT + TAP_EMPTY;
};
// applies the keys of one typed question to s.buf (see the table above)
function kbKey(s, raw) {
  const d = String(raw || '').replace(/#/g, '').trim();
  for (const r of d.match(/(\d)\1*/g) || []) {
    const k = r[0], n = r.length;
    if (k === '1') { s.buf += '1'.repeat(Math.floor(n / 2)); continue; }
    if (n === 5) { s.buf += k; continue; }
    if (k === '0') {
      if (n === 1) s.buf += ' ';
      else if (n === 2) s.buf = s.buf.slice(0, -1);
      continue;
    }
    const L = KB_KEYS[k];
    if (L && n <= L.length) s.buf += L[n - 1];
  }
}
// the typed keys of the whole question arrive in one request, ended by #
async function kbStep(s, q, id, T0, first) {
  const d = digitsOf(first !== undefined ? first : q[s.p]);
  if (!d) return tapAny(s, 't-' + sp('לא הוקלד כלום'));
  s.buf = '';
  kbKey(s, d);
  const text = kbFinal(s.buf.replace(/\s+/g, ' ').trim().slice(0, 600));
  s.buf = '';
  if (!text) return kbAsk(s, 't-' + sp('לא הוקלד טקסט נסו שוב'));
  return runTurn(s, q, id, T0, text);
}
// the next request of a call: decides between typing, recording and the hold music of a question that is being answered
async function turnStep(s, q, id, T0) {
  if (s.job) return holdStep(s, id);
  if (s.mode === 'menu') {
    const d = digitsOf(q[s.p]);
    if (d === '1') { s.miss = 0; return askFor(s, recPre(s)); }
    if (d === '2') { s.miss = 0; s.buf = ''; const help = s.kbSeen ? KB_SHORT : KB_START; s.kbSeen = true; return kbAsk(s, 't-' + help); }
    s.miss = (s.miss || 0) + 1;
    if (s.miss >= 3) return 'id_list_message=t-' + sp('להתראות');
    return tapAny(s, 't-' + sp(d ? 'המקש לא מוכר' : 'לא התקבלה בחירה'));
  }
  if (s.mode === 'type') return kbStep(s, q, id, T0);
  return runTurn(s, q, id, T0);
}

function endCall(id) {
  const old = calls[id];
  if (old && old.r) del(old.r, old.d);
  delete calls[id];
}

// starts the turn in the background and plays the songs of the songs folder until the answer is ready
function runTurn(s, q, id, T0, typed) {
  if (!typed && !q[s.p]) return tapAny(s, 't-' + AGAIN);
  s.jobT0 = Date.now();
  s.hold = null;
  s.holdP = songsFor(s.ph).catch(() => []);
  s.job = doTurn(s, q, id, s.jobT0, typed).catch(e => { console.error(id, 'turn crashed', e && e.message); return tapAny(s, 't-' + ERR); });
  return holdStep(s, id);
}

async function holdStep(s, id) {
  const files = await Promise.race([s.holdP, sleep(2500).then(() => [])]);
  // no songs: wait for the answer as before
  if (!files || !files.length) { const r = await s.job; s.job = null; return r; }
  const r = await Promise.race([s.job, sleep(HOLD_LAG_MS).then(() => null)]);
  if (r !== null) { s.job = null; return r; }
  if (Date.now() - s.jobT0 > BUDGET + 15000) { s.job = null; return tapAny(s, 't-' + ERR); }
  if (!s.hold) s.hold = { i: Math.floor(Math.random() * files.length) };
  const msgs = [];
  for (let k = 0; k < HOLD_CHAIN; k++) msgs.push('f-' + SD + '/' + files[(s.hold.i + k) % files.length]);
  s.hold.i = (s.hold.i + HOLD_CHAIN) % files.length;
  s.hn++;
  return 'read=' + msgs.join('.') + '=H' + s.e + s.hn + ',no,1,1,1' + TAP_EMPTY;
}

// one turn: take the recording (or the typed text), ask Gemini, read the answer aloud, upload it; returns the reply for Yemot
async function doTurn(s, q, id, T0, typed) {
  const ask = pre => tapAny(s, pre);
  // after the answer the caller is invited to type or record the next question
  const more = pre => ask(pre + '.t-' + KB_MORE);
  const deadline = T0 + BUDGET;
  const qn = s.name;
  try {
    let userPart;
    if (typed) {
      userPart = { text: 'השאלה הוקלדה במקשי הטלפון ולכן ייתכנו בה שגיאות כתיב ובלי סימני פיסוק. הבן את הכוונה וענה: ' + typed };
    } else {
      const audio = await download(qn, deadline, s.d);
      del(qn, s.d);
      userPart = { inlineData: { mimeType: 'audio/wav', data: audio.toString('base64') } };
    }
    if (s.r) { del(s.r, s.d); s.r = ''; }
    const t1 = Date.now();

    const a = await askModel(s.sys, [...(s.base || []), ...s.h.slice(-8), { role: 'user', parts: [userPart] }], deadline, s);
    const parts = (((a.candidates || [])[0] || {}).content || {}).parts || [];
    let text = parts.filter(p => !p.thought).map(p => p.text || '').join('').trim();
    if (!text) throw new Error('empty answer ' + JSON.stringify((a.promptFeedback || {})).slice(0, 100));
    const ctl = parseCtl(text);
    text = ctl.text || 'בסדר';
    if (ctl.ctl.voice === 'male' || ctl.ctl.voice === 'female') s.vc = ctl.ctl.voice;
    else if (ctl.ctl.voice === 'default') s.vc = '';
    if (ctl.ctl.pace === 'slow' || ctl.ctl.pace === 'fast') s.pace = ctl.ctl.pace;
    else if (ctl.ctl.pace === 'normal') s.pace = '';
    const qtext = typed || ctl.q;
    const histQ = { role: 'user', parts: [{ text: qtext || '[שאלה קולית]' }] };
    // the history keeps text only (question and answer), read back later by the Yemot voice
    s.save = { qt: qtext || 'לא תומללה', at: text };
    const t2 = Date.now();

    let pcm = null;
    try {
      pcm = await tts(text, deadline, { voice: VOICE_BY[s.vc], pace: s.pace });
    } catch (te) {
      console.error(id, 'gemini voice unavailable, Yemot reads the answer:', String(te.message).slice(0, 80));
    }
    const t3 = Date.now();
    // a requested file is played right after the answer
    const media = await takeMedia(s);
    const tail = media ? '.' + media : '';
    s.h.push(histQ, { role: 'model', parts: [{ text }] });
    if (s.h.length > 12) s.h = s.h.slice(-12);

    // no Gemini audio: Yemot reads the text itself
    if (!pcm) {
      console.log(id, 'turn', s.n, 'ok (yemot voice)', 'gemini', t2 - t1, 'ms total', Date.now() - T0, 'ms');
      return more('t-' + (sp(text) || ERR) + tail);
    }

    const rn = 'r' + s.e + 'n' + s.n;
    await upload(rn, pcm, deadline, s.d);
    s.r = rn;
    console.log(id, 'turn', s.n, typed ? 'ok (typed)' : 'ok', 'gemini', t2 - t1, 'ms tts', t3 - t2, 'ms total', Date.now() - T0, 'ms');
    return more('f-' + s.d + '/' + rn + tail);
  } catch (e) {
    console.error(id, 'turn', s.n, 'failed after', Date.now() - T0, 'ms:', e.message, e.stderr ? '| ' + String(e.stderr).replace(/\s+/g, ' ') : '');
    s.mediaP = null;
    s.save = null;
    if (!typed) del(qn, s.d);
    return ask('t-' + ERR);
  }
}

// ---------- history: every question and answer is kept as a recording in the history extension of Yemot ----------
// file names (letters and digits only): p<phone>c<8 chars of time>t<turn>q  question, ...t<turn>a  answer, p<phone>c<time>n  spoken name
const HIST = String(process.env.HISTORY_EXT || '').replace(/^\/+|\/+$/g, '');
const HD = /^[0-9]+(\/[0-9]+)*$/.test(HIST) ? '/' + HIST : '';
const CONT_TURNS = 2; // how many of the last turns are given to Gemini when a saved conversation is continued
const phoneOf = q => { const p = String(q.ApiPhone || '').replace(/\D/g, ''); return p.length >= 7 && p.length <= 15 ? p : ''; };
const hName = (ph, cid, suffix) => 'p' + ph + 'c' + cid + suffix;
const sortedTurns = c => Object.keys(c.turns).map(Number).filter(n => c.turns[n].q && c.turns[n].a).sort((x, y) => x - y);

// runs after the answer was sent, so it never slows the call; question and answer are saved as text files
async function saveTurn(s, sv) {
  if (!HD || !s.ph) return;
  if (!s.cid) { s.cid = Date.now().toString(36).padStart(8, '0'); s.tn = 0; }
  const cid = s.cid, t = ++s.tn;
  const dl = Date.now() + 45000;
  await uploadText(hName(s.ph, cid, 't' + t + 'q'), sv.qt, dl, HD);
  await uploadText(hName(s.ph, cid, 't' + t + 'a'), sv.at, dl, HD);
}
function flushSave(s) {
  const sv = s.save; s.save = null;
  if (sv && HD && s.ph) saveTurn(s, sv).catch(e => console.error('history save failed:', e.message));
}

// reads the file list of the history extension and groups the files of this caller into conversations, newest first
async function histList(ph, deadline) {
  const r = await http(YM + 'GetIVR2Dir?token=' + encodeURIComponent(TOKEN) + '&path=' + encodeURIComponent('ivr2:' + HD), {}, 10000, deadline);
  const j = await r.json().catch(() => ({}));
  if (j.responseStatus !== 'OK') throw new Error('history list failed ' + JSON.stringify(j).slice(0, 120));
  const txt = JSON.stringify(j);
  const re = new RegExp('p' + ph + 'c([0-9a-z]{8})(?:t(\\d+)([qa])|n)\\.(wav|txt)', 'g');
  const map = new Map();
  let m;
  while ((m = re.exec(txt))) {
    const c = map.get(m[1]) || { cid: m[1], turns: {}, name: false };
    if (m[2]) { const tt = c.turns[m[2]] = c.turns[m[2]] || {}; tt[m[3]] = true; if (m[4] === 'txt') tt.txt = true; } else c.name = true;
    map.set(m[1], c);
  }
  return [...map.values()].filter(c => sortedTurns(c).length).sort((x, y) => (x.cid < y.cid ? 1 : -1));
}

const dateOf = cid => {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', day: 'numeric', month: 'numeric' }).formatToParts(new Date(parseInt(cid, 36)));
    const g = t => (parts.find(x => x.type === t) || {}).value;
    return Number(g('day')) + ' ' + Number(g('month'));
  } catch (e) { return ''; }
};
const HMENU = sp('להשמעה הקש 1 להמשך השיחה הקש 2 למחיקה הקש 3 לשינוי שם הקש 4 לשיחה הבאה הקש 5 לשיחה הקודמת הקש 6 ליציאה הקש 0');

// announces the current conversation (its spoken name, or its date) and asks what to do with it
function showItem(s, intro) {
  const c = s.list[s.i];
  const msgs = [];
  if (intro) msgs.push('t-' + sp(intro));
  msgs.push('t-' + sp('שיחה מספר ' + (s.i + 1) + ' מתוך ' + s.list.length));
  msgs.push(c.name ? 'f-' + HD + '/' + hName(s.ph, c.cid, 'n') : 't-' + sp('מתאריך ' + dateOf(c.cid)));
  msgs.push('t-' + HMENU);
  s.hm = 'menu';
  return tapFor(s, msgs.join('.'));
}

async function playConv(s) {
  const c = s.list[s.i];
  const msgs = [];
  const dl = Date.now() + 20000;
  for (const n of sortedTurns(c)) {
    if (c.turns[n].txt) {
      // typed question: no recording, the Yemot voice reads the saved text
      let qt = '', at = '';
      try { [qt, at] = await Promise.all([downloadText(hName(s.ph, c.cid, 't' + n + 'q'), dl, HD), downloadText(hName(s.ph, c.cid, 't' + n + 'a'), dl, HD)]); } catch (e) { console.error('history text failed:', e.message); }
      msgs.push('t-' + sp('שאלה'), 't-' + (sp(qt) || sp('לא זמין')), 't-' + sp('תשובה'), 't-' + (sp(at) || sp('לא זמין')));
      continue;
    }
    msgs.push('t-' + sp('שאלה'), 'f-' + HD + '/' + hName(s.ph, c.cid, 't' + n + 'q'), 't-' + sp('תשובה'), 'f-' + HD + '/' + hName(s.ph, c.cid, 't' + n + 'a'));
  }
  msgs.push('t-' + HMENU);
  s.hm = 'menu';
  return tapFor(s, msgs.join('.'));
}

// the last turns of the saved conversation are given to Gemini as recordings, then the caller keeps talking in the same conversation
async function continueConv(s) {
  const c = s.list[s.i];
  const all = sortedTurns(c);
  const last = all.slice(-CONT_TURNS);
  const dl = Date.now() + 30000;
  const parts = [{ text: 'זה ההקשר משיחה קודמת עם המשתמש. אחריו תגיע שאלה חדשה שלו, והמשך את השיחה בהתאם.' }];
  for (const n of last) {
    if (c.turns[n].txt) {
      const [qt, at] = await Promise.all([downloadText(hName(s.ph, c.cid, 't' + n + 'q'), dl, HD), downloadText(hName(s.ph, c.cid, 't' + n + 'a'), dl, HD)]);
      parts.push({ text: 'שאלה קודמת של המשתמש: ' + qt }, { text: 'התשובה הקודמת שלך: ' + at });
      continue;
    }
    const [qa, aa] = await Promise.all([download(hName(s.ph, c.cid, 't' + n + 'q'), dl, HD), download(hName(s.ph, c.cid, 't' + n + 'a'), dl, HD)]);
    parts.push({ text: 'שאלה קודמת של המשתמש בהקלטה:' }, { inlineData: { mimeType: 'audio/wav', data: qa.toString('base64') } });
    parts.push({ text: 'התשובה הקודמת שלך בהקלטה:' }, { inlineData: { mimeType: 'audio/wav', data: aa.toString('base64') } });
  }
  s.base = [{ role: 'user', parts }, { role: 'model', parts: [{ text: 'הבנתי אמשיך את השיחה.' }] }];
  s.h = [];
  s.cid = c.cid;
  s.tn = Math.max(...Object.keys(c.turns).map(Number));
  s.hm = 'talk';
  return tapAny(s, 't-' + sp('אפשר להמשיך'));
}

async function historyStep(s, q) {
  const deadline = Date.now() + 25000;
  if (!s.hm) {
    s.list = await histList(s.ph, deadline);
    if (!s.list.length) return 'id_list_message=t-' + sp('אין עדיין שיחות שמורות');
    s.i = 0;
    return showItem(s, 'שלום יש לך ' + s.list.length + ' שיחות שמורות');
  }
  const d = String(q[s.p] || '').trim();
  const c = s.list[s.i];
  if (s.hm === 'del') {
    if (d !== '1') return showItem(s, 'המחיקה בוטלה');
    for (const n of Object.keys(c.turns)) { const x = c.turns[n].txt ? '.txt' : ''; del(hName(s.ph, c.cid, 't' + n + 'q') + x, HD); del(hName(s.ph, c.cid, 't' + n + 'a') + x, HD); }
    if (c.name) del(hName(s.ph, c.cid, 'n'), HD);
    s.list.splice(s.i, 1);
    if (!s.list.length) return 'id_list_message=t-' + sp('השיחה נמחקה ואין עוד שיחות שמורות');
    s.i = Math.min(s.i, s.list.length - 1);
    return showItem(s, 'השיחה נמחקה');
  }
  if (s.hm === 'rename') {
    c.name = !!q[s.p];
    return showItem(s, c.name ? 'השם נשמר' : 'לא הוקלט שם');
  }
  switch (d) {
    case '1': return await playConv(s);
    case '2':
      try { return await continueConv(s); } catch (e) { console.error('continue failed:', e.message); return showItem(s, 'הייתה תקלה'); }
    case '3':
      s.hm = 'del';
      return tapFor(s, 't-' + sp('למחיקת השיחה לצמיתות הקש 1 לביטול הקש 2'));
    case '4': {
      const f = hName(s.ph, c.cid, 'n');
      if (c.name) del(f, HD);
      s.hm = 'rename';
      s.n++;
      s.p = 'R' + s.e + s.n;
      return 'read=t-' + sp('אחרי הצליל אמור את השם החדש ובסיום הקש סולמית') + '=' + s.p + ',no,record,' + HD + ',' + f + ',no,,,1,8';
    }
    case '5': s.i = (s.i + 1) % s.list.length; return showItem(s);
    case '6': s.i = (s.i - 1 + s.list.length) % s.list.length; return showItem(s);
    case '0': return 'id_list_message=t-' + sp('להתראות');
    default: return showItem(s);
  }
}

// ---------- songs folder: music that plays while the answer is being prepared ----------
// SONGS_EXT = the Yemot extension (folder) that holds the songs. The caller hears the songs of the folder from the moment the question
// is sent until the answer is ready. Yemot cannot interrupt a playing file, so every song is cut into short pieces (SONG_SEG_SEC seconds)
// and the server plays a few pieces at a time and checks again whether the answer is ready.
// piece names (letters and digits only): hs<id>x<NNN> shared song, hp<phone>s<id>x<NNN> song of one caller.
// a caller with songs of his own hears only them; everyone else hears the shared songs.
// songs get into the folder in two ways: the page /songs (password SONGS_PASS), or any audio file dropped in the folder (it is cut automatically
// and removed; a file named p<phone>_name.mp3 becomes a personal song).
const SONGS = String(process.env.SONGS_EXT || '').replace(/^\/+|\/+$/g, '');
const SD = /^[0-9]+(\/[0-9]+)*$/.test(SONGS) ? '/' + SONGS : '';
const SONGS_PASS = String(process.env.SONGS_PASS || '');
const SEG_SEC = Math.min(30, Math.max(3, parseInt(process.env.SONG_SEG_SEC, 10) || 5));
const HOLD_CHAIN = Math.min(6, Math.max(1, parseInt(process.env.HOLD_CHAIN, 10) || 2));
const HOLD_LAG_MS = 1200;
const SONG_MAX_SEC = (parseInt(process.env.SONG_MAX_MIN, 10) || 6) * 60;
const SONG_RE = 'h(?:p(\\d{7,15}))?s([0-9a-f]{6})x(\\d{3})\\.wav';
const enc = encodeURIComponent;
let songCache = { t: 0, tracks: new Map() };

// reads the songs folder: the pieces grouped by song, and the files that were dropped there and still have to be cut
async function songList(deadline) {
  const r = await http(YM + 'GetIVR2Dir?token=' + enc(TOKEN) + '&path=' + enc('ivr2:' + SD), {}, 10000, deadline);
  const j = await r.json().catch(() => ({}));
  if (j.responseStatus !== 'OK') throw new Error('songs list failed ' + JSON.stringify(j).slice(0, 120));
  const txt = JSON.stringify(j);
  const tracks = new Map();
  for (const m of txt.matchAll(new RegExp('(?<![A-Za-z0-9])' + SONG_RE, 'g'))) {
    const key = (m[1] || '') + 's' + m[2];
    const t = tracks.get(key) || { owner: m[1] || '', id: m[2], parts: new Set() };
    t.parts.add(m[0].replace(/\.wav$/, ''));
    tracks.set(key, t);
  }
  const chunk = new RegExp('^' + SONG_RE + '$');
  const raw = [...new Set([...txt.matchAll(/(?<![A-Za-z0-9_\-])([A-Za-z0-9_\-]+\.(?:wav|mp3|m4a|mp4|ogg|aac))/gi)].map(m => m[1]))].filter(n => !chunk.test(n));
  return { tracks, raw };
}

// the pieces the caller hears while waiting, in order (his own songs, else the shared ones); the list is cached for two minutes
async function songsFor(ph) {
  if (!SD) return [];
  const now = Date.now();
  if (now - songCache.t > 120000) {
    try { songCache = { t: now, tracks: (await songList(now + 8000)).tracks }; }
    catch (e) { console.error(String(e.message).slice(0, 150)); songCache.t = now - 90000; }
  }
  const all = [...songCache.tracks.values()];
  const mine = ph ? all.filter(t => t.owner === ph) : [];
  const use = (mine.length ? mine : all.filter(t => !t.owner)).sort((x, y) => (x.id < y.id ? -1 : 1));
  return use.flatMap(t => [...t.parts].sort());
}

// cuts an audio or video file into phone-format pieces and uploads them to the songs folder; owner = phone number, or empty for everyone
async function ingestSong(buf, owner) {
  if (!SD) throw new Error('SONGS_EXT לא הוגדר');
  if (!FFMPEG) throw new Error('ffmpeg לא זמין בשרת');
  const id = crypto.randomBytes(3).toString('hex');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'song-'));
  const done = [];
  try {
    fs.writeFileSync(path.join(dir, 'in.bin'), buf);
    await execFileP(FFMPEG, ['-y', '-v', 'error', '-i', path.join(dir, 'in.bin'), '-vn', '-t', String(SONG_MAX_SEC), '-ar', '8000', '-ac', '1', '-c:a', 'pcm_s16le', '-f', 'segment', '-segment_time', String(SEG_SEC), '-reset_timestamps', '1', path.join(dir, 'p%03d.wav')], { timeout: 120000 });
    const files = fs.readdirSync(dir).filter(f => /^p\d{3}\.wav$/.test(f)).sort();
    if (!files.length) throw new Error('הקובץ לא זוהה כקובץ שמע');
    const dl = Date.now() + 240000;
    const base = 'h' + (owner ? 'p' + owner : '') + 's' + id + 'x';
    let next = 0, failed = null;
    const worker = async () => {
      while (!failed) {
        const k = next++;
        if (k >= files.length) return;
        const name = base + String(k).padStart(3, '0');
        try { await upload(name, fs.readFileSync(path.join(dir, files[k])), dl, SD, 30000); done.push(name); } catch (e) { failed = e; }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    if (failed) { for (const n of done) del(n, SD); throw failed; }
    songCache.t = 0;
    return { id, parts: files.length };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// files that were dropped in the songs folder (for example through the Yemot file manager) are cut and replaced by pieces
let scanning = false;
const rawFail = {};
async function scanRaw() {
  if (!SD || scanning || !TOKEN) return;
  scanning = true;
  try {
    const l = await songList(Date.now() + 10000);
    for (const name of l.raw) {
      if ((rawFail[name] || 0) > Date.now()) continue;
      try {
        const r = await http(YM + 'DownloadFile?token=' + enc(TOKEN) + '&path=' + enc(yp(name, SD)), {}, 60000, Date.now() + 90000);
        const b = Buffer.from(await r.arrayBuffer());
        if (!r.ok || b.length < 1000 || b[0] === 0x7b) throw new Error('download failed ' + r.status + ' ' + b.length + ' ' + b.subarray(0, 60).toString('utf8').replace(/\s+/g, ' '));
        const mo = /^p(\d{7,15})[_\-]/.exec(name);
        await ingestSong(b, mo ? mo[1] : '');
        del(name, SD);
        console.log('song ingested from', name);
      } catch (e) {
        rawFail[name] = Date.now() + 3600000;
        console.error('song ingest failed', name, String(e.message).slice(0, 120));
      }
    }
  } catch (e) {
    console.error('songs scan failed:', String(e.message).slice(0, 120));
  } finally {
    scanning = false;
  }
}
if (SD) { setTimeout(scanRaw, 20000).unref(); setInterval(scanRaw, 600000).unref(); }

// ---------- the page for adding songs ----------
const songsAuth = req => !!SONGS_PASS && safeEq(String(req.get('x-songs-pass') || ''), SONGS_PASS);
const SONGS_PAGE = `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>תקיית שירים</title>
<style>body{font-family:Arial,sans-serif;max-width:560px;margin:24px auto;padding:0 14px;line-height:1.5}label{display:block;margin-top:14px;font-weight:bold}input,button{font-size:16px;padding:8px;width:100%;box-sizing:border-box;margin-top:4px}button{cursor:pointer;margin-top:14px}#msg{margin-top:14px;font-weight:bold}li{margin:6px 0}.d{width:auto;padding:2px 10px;margin:0 8px}</style></head><body>
<h2>תקיית שירים</h2><p>השירים מושמעים למתקשר מרגע שליחת השאלה ועד שהתשובה מוכנה.</p>
<label>סיסמה<input id="pw" type="password"></label>
<label>מספר טלפון של המשתמש (ריק = שיר לכולם)<input id="ph" inputmode="numeric" placeholder="0501234567"></label>
<label>קובץ שמע או וידאו<input id="f" type="file" accept="audio/*,video/*"></label>
<button id="up">העלאה</button><button id="ls">הצגת השירים</button><div id="msg"></div><ul id="l"></ul>
<script>
var $=function(i){return document.getElementById(i)};
function say(t){$('msg').textContent=t}
function hd(){return{'x-songs-pass':$('pw').value}}
function ph(){return $('ph').value.replace(/\\D/g,'')}
$('up').onclick=async function(){var f=$('f').files[0];if(!f){say('בחרו קובץ');return}say('מעלה וחותך את הקובץ, זה יכול לקחת כחצי דקה...');
try{var r=await fetch('/songs/upload?phone='+ph(),{method:'POST',headers:hd(),body:await f.arrayBuffer()});var j=await r.json();say(j.ok?'השיר נוסף ('+j.parts+' חלקים)':(j.error||'שגיאה'))}catch(e){say('שגיאה: '+e.message)}};
$('ls').onclick=async function(){try{var r=await fetch('/songs/list?phone='+ph(),{headers:hd()});var j=await r.json();if(!r.ok){say(j.error||'שגיאה');return}say(j.songs.length?'':'אין שירים');
var l=$('l');l.innerHTML='';j.songs.forEach(function(s){var li=document.createElement('li');li.textContent='שיר '+s.id+' ('+s.seconds+' שניות, '+(s.owner||'לכולם')+')';var b=document.createElement('button');b.className='d';b.textContent='מחיקה';b.onclick=async function(){await fetch('/songs/delete?owner='+s.owner+'&id='+s.id,{method:'POST',headers:hd()});$('ls').click()};li.appendChild(b);l.appendChild(li)})}catch(e){say('שגיאה: '+e.message)}};
</script></body></html>`;
app.get('/songs', (req, res) => res.type('html').send(SONGS_PAGE));
app.post('/songs/upload', express.raw({ type: () => true, limit: '40mb' }), async (req, res) => {
  if (!SD) return res.status(400).json({ error: 'SONGS_EXT לא הוגדר בשירות' });
  if (!songsAuth(req)) return res.status(403).json({ error: 'סיסמה שגויה או שלא הוגדרה SONGS_PASS' });
  const ph = String(req.query.phone || '').replace(/\D/g, '');
  if (ph && (ph.length < 7 || ph.length > 15)) return res.status(400).json({ error: 'מספר טלפון לא תקין' });
  if (!Buffer.isBuffer(req.body) || req.body.length < 1000) return res.status(400).json({ error: 'לא התקבל קובץ' });
  try {
    const r = await ingestSong(req.body, ph);
    res.json({ ok: true, id: r.id, parts: r.parts });
  } catch (e) {
    console.error('song upload failed:', String(e.message).slice(0, 200));
    res.status(500).json({ error: String(e.message).slice(0, 200) });
  }
});
app.get('/songs/list', async (req, res) => {
  if (!SD) return res.status(400).json({ error: 'SONGS_EXT לא הוגדר בשירות' });
  if (!songsAuth(req)) return res.status(403).json({ error: 'סיסמה שגויה או שלא הוגדרה SONGS_PASS' });
  try {
    const ph = String(req.query.phone || '').replace(/\D/g, '');
    const l = await songList(Date.now() + 12000);
    const songs = [...l.tracks.values()].filter(t => !ph || t.owner === ph || !t.owner).map(t => ({ id: t.id, owner: t.owner, seconds: t.parts.size * SEG_SEC }));
    res.json({ songs });
  } catch (e) {
    res.status(500).json({ error: String(e.message).slice(0, 200) });
  }
});
app.post('/songs/delete', async (req, res) => {
  if (!SD) return res.status(400).json({ error: 'SONGS_EXT לא הוגדר בשירות' });
  if (!songsAuth(req)) return res.status(403).json({ error: 'סיסמה שגויה או שלא הוגדרה SONGS_PASS' });
  const id = String(req.query.id || ''), owner = String(req.query.owner || '').replace(/\D/g, '');
  if (!/^[0-9a-f]{6}$/.test(id)) return res.status(400).json({ error: 'מזהה לא תקין' });
  try {
    const l = await songList(Date.now() + 12000);
    const t = l.tracks.get(owner + 's' + id);
    if (!t) return res.status(404).json({ error: 'השיר לא נמצא' });
    for (const n of t.parts) del(n, SD);
    songCache.t = 0;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message).slice(0, 200) });
  }
});

app.all(['/yemot', '/yemot/:e'], async (req, res) => {
  const q = { ...req.query, ...req.body };
  const id = idOf(q);
  res.type('text/plain');
  const T0 = Date.now();
  const ext = EXTS[String(req.params.e || '')] || EXT_FIRST;
  try {
    if (q.hangup === 'yes') {
      endCall(id);
      return res.send('noop=bye');
    }

    const s = calls[id] || (calls[id] = newSession(ext.d, ext.sys, ext.g, { ph: phoneOf(q) }));
    s.t = Date.now();

    // first request of the call: the opening message, then the line waits for typing or for silence (recording)
    if (!s.mode) {
      const hasGreet = (await Promise.all([greetFile(s.d, Date.now() + 4000), Promise.race([ensureBeep(s.d), sleep(5000).then(() => false)])]))[0];
      const g = hasGreet ? 'f-' + s.d + '/greet' : 't-' + s.g;
      return res.send(tapAny(s, g));
    }
    console.log(id, 'req', s.mode || '-', 'in', JSON.stringify(q[s.p] === undefined ? null : q[s.p]));
    const out = await turnStep(s, q, id, T0);
    res.send(out);
    flushSave(s);
  } catch (e) {
    // last resort: always answer Yemot with plain text, never HTML or an empty reply
    console.error(id, 'fatal', e.message);
    if (!res.headersSent) res.send('id_list_message=t-' + ERR);
  }
});

// the history extension: point an API extension of Yemot to https://<your service>/history
app.all('/history', async (req, res) => {
  const q = { ...req.query, ...req.body };
  const id = idOf(q);
  res.type('text/plain');
  const T0 = Date.now();
  try {
    if (q.hangup === 'yes') {
      endCall(id);
      return res.send('noop=bye');
    }
    if (!HD) return res.send('id_list_message=t-' + sp('שלוחת ההיסטוריה עדיין לא הוגדרה'));
    const ph = phoneOf(q);
    if (!ph) return res.send('id_list_message=t-' + sp('לא זוהה מספר הטלפון ולכן אי אפשר להשמיע היסטוריה'));

    const s = calls[id] || (calls[id] = newSession(HD, EXT_FIRST.sys, '', { ph, hm: '', list: [], i: 0 }));
    s.t = Date.now();
    if (!s.hm) console.log(id, 'history start, params:', Object.keys(q).join(','));

    if (s.hm === 'talk') {
      console.log(id, 'req', s.mode || '-', 'in', JSON.stringify(q[s.p] === undefined ? null : q[s.p]));
    const out = await turnStep(s, q, id, T0);
      res.send(out);
      flushSave(s);
      return;
    }
    return res.send(await historyStep(s, q));
  } catch (e) {
    console.error(id, 'history fatal', e.message);
    if (!res.headersSent) res.send('id_list_message=t-' + ERR);
  }
});

// the opening message can be a recording made by Gemini; it is played when the file greet.wav exists in the extension
const greetOk = {};
async function greetFile(d, deadline) {
  if (greetOk[d] !== undefined) return greetOk[d];
  try {
    const r = await http(YM + 'GetIVR2Dir?token=' + encodeURIComponent(TOKEN) + '&path=' + encodeURIComponent('ivr2:' + d), {}, 3500, deadline);
    const j = await r.json().catch(() => ({}));
    if (j.responseStatus !== 'OK') return false;
    greetOk[d] = JSON.stringify(j).includes('greet.wav');
    return greetOk[d];
  } catch (e) {
    return false;
  }
}

// asks Gemini to read the given text aloud and stores it as a file in the given extension
// dir is an extension number such as 5 or 5/2, or empty for the main menu of the line; file is the name without .wav
let lastRec = 0;
app.post('/record', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*').type('text/plain; charset=utf-8');
  try {
    if (!TOKEN || !safeEq((req.body || {}).token || '', TOKEN)) return res.send('ERR הטוקן לא תואם לטוקן ששמור בשירות');
    if (Date.now() - lastRec < 6000) return res.send('ERR חכו כמה שניות ונסו שוב');
    const dir = String(req.body.dir || '').replace(/^\/+|\/+$/g, '');
    const file = String(req.body.file || 'greet');
    if (dir && !/^[0-9]+(\/[0-9]+)*$/.test(dir)) return res.send('ERR מספר שלוחה לא תקין');
    if (!/^[A-Za-z0-9_]{1,20}$/.test(file)) return res.send('ERR שם קובץ לא תקין');
    const text = String(req.body.text || '').replace(/\s+/g, ' ').trim().slice(0, 600);
    if (!text) return res.send('ERR הטקסט ריק');
    lastRec = Date.now();
    const d = dir ? '/' + dir : '';
    const deadline = Date.now() + 80000;
    const pcm = await tts(text, deadline);
    await upload(file, pcm, deadline, d);
    if (file === 'greet') greetOk[d] = true;
    res.send('OK ההקלטה נוצרה על ידי ג׳מיני והועלתה אל ' + (dir ? 'שלוחה ' + dir : 'השלוחה הראשית') + ' בשם ' + file + '.wav (' + Math.round(pcm.length / 1024) + 'KB)');
  } catch (e) {
    res.send('ERR ' + String(e.message).slice(0, 200));
  }
});

// quick end to end check of the whole chain, without a phone call
let lastTest = 0;
app.get('/selftest', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*').type('text/plain; charset=utf-8');
  if (Date.now() - lastTest < 20000) return res.send('ERR נבדק הרגע, חכו 20 שניות ונסו שוב');
  lastTest = Date.now();
  const out = [];
  const deadline = Date.now() + 90000;
  const step = async (name, fn) => {
    try { out.push('OK  ' + name + (await fn() || '')); }
    catch (e) { out.push('ERR ' + name + ': ' + String(e.message).slice(0, 220)); }
  };
  const silent = wav(Buffer.alloc(3200), 8000);

  await step('מפתחות ג׳מיני לתמלול', async () => { if (!KEYS.length) throw new Error('GEMINI_API_KEYS ריק'); return ' (' + KEYS.length + ')'; });
  await step('מפתחות ג׳מיני להקראה', async () => { if (!TTS_KEYS.length) throw new Error('GEMINI_TTS_KEYS ריק'); return ' (' + TTS_KEYS.length + ')'; });
  if (GROQ_KEYS.length) await step('חיפוש Groq (' + GROQ_KEYS.length + ' מפתחות)', async () => {
    const r = await groqSearch('weather today', '', deadline);
    if (r.error) throw new Error(r.error);
    return ' (' + String(r.answer || '').length + ' תווים)';
  });
  await step('טוקן ימות', async () => { if (!TOKEN || /undefined/.test(TOKEN)) throw new Error('YEMOT_TOKEN ריק'); });
  await step('ימות: קריאת השלוחה ' + EXT, async () => {
    const r = await http(YM + 'GetIVR2Dir?token=' + encodeURIComponent(TOKEN) + '&path=' + encodeURIComponent('ivr2:' + EXTP), {}, 10000, deadline);
    const j = await r.json().catch(() => ({}));
    if (j.responseStatus !== 'OK') throw new Error(JSON.stringify(j).slice(0, 180));
  });
  if (HD) await step('ימות: קריאת שלוחת ההיסטוריה ' + HD, async () => {
    const r = await http(YM + 'GetIVR2Dir?token=' + encodeURIComponent(TOKEN) + '&path=' + encodeURIComponent('ivr2:' + HD), {}, 10000, deadline);
    const j = await r.json().catch(() => ({}));
    if (j.responseStatus !== 'OK') throw new Error(JSON.stringify(j).slice(0, 180));
  });
  if (SD) await step('ימות: קריאת תקיית השירים ' + SD, async () => {
    const l = await songList(deadline);
    const n = [...l.tracks.values()].length;
    if (!FFMPEG) throw new Error('אין ffmpeg: אי אפשר לחתוך שירים');
    await execFileP(FFMPEG, ['-version'], { timeout: 8000 });
    return ' (' + n + ' שירים, ' + l.raw.length + ' קבצים שממתינים לחיתוך' + (SONGS_PASS ? '' : ', SONGS_PASS לא הוגדר: דף ההעלאה חסום') + ')';
  });
  if (JAMENDO_ID) await step('Jamendo (חיפוש שירים)', async () => {
    const r = await jamendoSearch({}, '', 'new', deadline);
    if (!r.length) throw new Error('לא חזרו שירים: בדקו את JAMENDO_CLIENT_ID');
    return ' (' + r.length + ' תוצאות)';
  });
  if (HAS_MEDIA) await step('קבצי שמע להשמעה (' + MEDIA.length + ')', async () => {
    if (!FFMPEG) return ' (ללא ffmpeg: יושמעו רק קבצי mp3 ו-wav)';
    await execFileP(FFMPEG, ['-version'], { timeout: 8000 });
  });
  await step('ימות: העלאה ומחיקה של קובץ', async () => {
    await upload('selftest', silent, deadline);
    const r = await http(YM + 'FileAction?token=' + encodeURIComponent(TOKEN) + '&action=delete&what=' + encodeURIComponent(yp('selftest')), {}, 8000, deadline);
    const j = await r.json().catch(() => ({}));
    if (j.responseStatus !== 'OK') throw new Error('מחיקה: ' + JSON.stringify(j).slice(0, 150));
  });
  if (HD) await step('ימות: שמירת טקסט להיסטוריה (שאלות מוקלדות)', async () => {
    await uploadText('selftesttxt', 'בדיקה', deadline, HD);
    const t = await downloadText('selftesttxt', deadline, HD);
    del('selftesttxt.txt', HD);
    if (t.trim() !== 'בדיקה') throw new Error('הטקסט שחזר שונה: ' + t.slice(0, 40));
  });
  await step('ג׳מיני ' + TEXT_MODEL + ' (קלט אודיו)', async () => {
    const a = await textGen({ contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'audio/wav', data: silent.toString('base64') } }, { text: 'ענה במילה אחת' }] }] }, deadline);
    if (!(((a.candidates || [])[0] || {}).content)) throw new Error('תשובה ריקה');
    return ' (thinking: ' + (THINK[thinkIdx[TEXT_MODEL] || 0] || 'ברירת מחדל') + ')';
  });
  await step('ג׳מיני ' + TTS_MODEL + ' (קול)', async () => {
    const p = await tts('בדיקה', deadline);
    return ' (' + Math.round(p.length / 1024) + 'KB)';
  });
  res.send(out.join('\n'));
});

app.use((err, req, res, next) => {
  console.error('express', err && err.message);
  if (!res.headersSent) res.type('text/plain').send('id_list_message=t-' + ERR);
});
process.on('unhandledRejection', e => console.error('unhandledRejection', e && e.message));
process.on('uncaughtException', e => console.error('uncaughtException', e && e.message));

app.listen(process.env.PORT || 3000, () => console.log('kav-ai up'));
