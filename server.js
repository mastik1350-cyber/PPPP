const express = require('express');
const crypto = require('crypto');
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
const TEXT_MODEL = process.env.TEXT_MODEL || 'gemini-3.6-flash';
// backup text model, used when the main one is overloaded (503/429/5xx); set TEXT_MODEL_FALLBACK to change it or to "none" to disable
const TEXT_FALLBACK_RAW = process.env.TEXT_MODEL_FALLBACK || 'gemini-3.6-flash';
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
const MAXW = Math.min(500, Math.max(5, parseInt(process.env.MAX_WORDS, 10) || 180));
const EXTRA = String(process.env.EXTRA_INSTRUCTION || '').replace(/\s+/g, ' ').trim().slice(0, 2000);
const buildSys = (mode, extra) => 'אתה עוזר קולי בטלפון. ' + MODES[MODES[String(mode)] ? String(mode) : '2'] +
  ' חובה מוחלטת: שמור על האופי הזה בכל תשובה ובכל סיבוב שיחה. ענה בעברית בתשובה מפורטת, מלאה ומסודרת, עם הסברים ודוגמאות כשזה עוזר, בעד ' + MAXW + ' מילים, בלי רשימות ובלי סימנים מיוחדים, כך שיהיה נעים להקשיב לה בטלפון. ' +
  (EXTRA ? 'הנחיה כללית מהבעלים: ' + EXTRA + ' ' : '') +
  (extra ? 'הנחיה לשלוחה הזאת מהבעלים: ' + extra + ' ' : '') + VOICE_CTL + (HAS_SEARCH ? SEARCH_HINT : '');

// one entry per Yemot extension: its own character mode, extra instruction and opening message
let CFG = [];
try { CFG = JSON.parse(process.env.EXTENSIONS || '[]'); } catch (e) { CFG = []; }
if (!Array.isArray(CFG) || !CFG.length) CFG = [{ p: EXT, m: process.env.MODE || '2', x: '', g: process.env.GREETING || '' }];
const DEFAULT_GREET = 'שלום הקלט את ההודעה בסיום הקש סולמית';
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
const yp = (name, d) => 'ivr2:' + (d === undefined ? EXTP : d) + '/' + name + '.wav';
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

// asks the model; when it calls web_search the search is run and the result is sent back, up to 3 rounds
async function askModel(sys, contents, deadline) {
  const base = { systemInstruction: { parts: [{ text: sys }] } };
  if (!HAS_SEARCH) return textGen({ ...base, contents }, deadline);
  for (let i = 0; i < 3; i++) {
    const a = await textGen({ ...base, contents, tools: [{ functionDeclarations: [SEARCH_DECL] }] }, deadline);
    const cand = (a.candidates || [])[0] || {};
    const fcalls = ((cand.content || {}).parts || []).filter(p => p.functionCall);
    if (!fcalls.length) return a;
    const resp = [];
    for (const c of fcalls) {
      const args = c.functionCall.args || {};
      console.log('search:', String(args.query || '').slice(0, 80));
      resp.push({ functionResponse: { name: c.functionCall.name, response: await webSearch(args.query, args.site, deadline) } });
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

// pulls [[VOICE:x]] / [[PACE:x]] tags out of the model answer
function parseCtl(text) {
  const ctl = {};
  const clean = text.replace(/\[\[\s*(VOICE|PACE)\s*:\s*([a-z]+)\s*\]\]/gi, (m, k, v) => { ctl[k.toLowerCase()] = v.toLowerCase(); return ' '; });
  return { text: clean.replace(/\s+/g, ' ').trim(), ctl };
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

async function upload(name, buf, deadline, d) {
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
      const r = await http(url, { method: 'POST', body: f }, 15000, deadline);
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.responseStatus === 'OK') return;
      last = JSON.stringify(j).slice(0, 200);
    } catch (e) {
      if (isBudget(e)) throw e;
      last = e.message;
    }
  }
  throw new Error('upload failed ' + last);
}

// cleanup is best effort and never blocks or fails a call
function del(name, d) {
  fetch(YM + 'FileAction?token=' + encodeURIComponent(TOKEN) + '&action=delete&what=' + encodeURIComponent(yp(name, d)), { signal: AbortSignal.timeout(8000) }).catch(() => {});
}

app.get('/', (q, r) => { r.set('Access-Control-Allow-Origin', '*'); r.send('ok'); });

// ---------- shared helpers of the call flow ----------
const idOf = q => String(q.ApiCallId || 'x').replace(/[^a-zA-Z0-9]/g, '').slice(-24) || 'x';
const newSession = (d, sys, g, extra) => Object.assign({ d, sys, g, n: 0, vc: '', pace: '', h: [], p: '', name: '', r: '', t: 0, e: crypto.randomBytes(3).toString('hex') }, extra || {});

// every turn uses a new parameter and file name, because Yemot accumulates parameters across requests
// (s.e keeps the names unique even if this server restarted in the middle of a call)
const askFor = (s, pre) => {
  s.n++;
  s.p = 'Q' + s.e + s.n;
  s.name = 'q' + s.e + 'n' + s.n;
  return 'read=' + pre + '=' + s.p + ',no,record,' + s.d + ',' + s.name + ',no,,,1,' + REC_MAX;
};
// asks for a single key press
const tapFor = (s, pre) => {
  s.n++;
  s.p = 'M' + s.e + s.n;
  return 'read=' + pre + '=' + s.p + ',no,tap,1,1,7,No';
};

function endCall(id) {
  const old = calls[id];
  if (old && old.r) del(old.r, old.d);
  delete calls[id];
}

// one turn: download the recording, ask Gemini, read the answer aloud, upload it; returns the reply for Yemot
async function runTurn(s, q, id, T0) {
  const ask = pre => askFor(s, pre);
  if (!q[s.p]) return ask('t-' + AGAIN);

  const deadline = T0 + BUDGET;
  const qn = s.name;
  try {
    const audio = await download(qn, deadline, s.d);
    del(qn, s.d);
    if (s.r) { del(s.r, s.d); s.r = ''; }
    const t1 = Date.now();

    const a = await askModel(s.sys, [...(s.base || []), ...s.h.slice(-8), { role: 'user', parts: [{ inlineData: { mimeType: 'audio/wav', data: audio.toString('base64') } }] }], deadline);
    const parts = (((a.candidates || [])[0] || {}).content || {}).parts || [];
    let text = parts.filter(p => !p.thought).map(p => p.text || '').join('').trim();
    if (!text) throw new Error('empty answer ' + JSON.stringify((a.promptFeedback || {})).slice(0, 100));
    const ctl = parseCtl(text);
    text = ctl.text || 'בסדר';
    if (ctl.ctl.voice === 'male' || ctl.ctl.voice === 'female') s.vc = ctl.ctl.voice;
    else if (ctl.ctl.voice === 'default') s.vc = '';
    if (ctl.ctl.pace === 'slow' || ctl.ctl.pace === 'fast') s.pace = ctl.ctl.pace;
    else if (ctl.ctl.pace === 'normal') s.pace = '';
    const t2 = Date.now();

    let pcm = null;
    try {
      pcm = await tts(text, deadline, { voice: VOICE_BY[s.vc], pace: s.pace });
    } catch (te) {
      console.error(id, 'gemini voice unavailable, Yemot reads the answer:', String(te.message).slice(0, 80));
    }
    const t3 = Date.now();

    // no Gemini audio: Yemot reads the text itself (no history recording for this turn)
    if (!pcm) {
      s.h.push({ role: 'user', parts: [{ text: '[שאלה קולית]' }] }, { role: 'model', parts: [{ text }] });
      if (s.h.length > 12) s.h = s.h.slice(-12);
      s.save = null;
      console.log(id, 'turn', s.n, 'ok (yemot voice)', 'gemini', t2 - t1, 'ms total', Date.now() - T0, 'ms');
      return ask('t-' + (sp(text) || ERR));
    }

    const rn = 'r' + s.e + 'n' + s.n;
    await upload(rn, pcm, deadline, s.d);
    s.r = rn;
    s.h.push({ role: 'user', parts: [{ text: '[שאלה קולית]' }] }, { role: 'model', parts: [{ text }] });
    if (s.h.length > 12) s.h = s.h.slice(-12);
    s.save = { audio, pcm };

    console.log(id, 'turn', s.n, 'ok', 'gemini', t2 - t1, 'ms tts', t3 - t2, 'ms total', Date.now() - T0, 'ms');
    return ask('f-' + s.d + '/' + rn);
  } catch (e) {
    console.error(id, 'turn', s.n, 'failed after', Date.now() - T0, 'ms:', e.message, e.stderr ? '| ' + String(e.stderr).replace(/\s+/g, ' ') : '');
    del(qn, s.d);
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

// runs after the answer was sent, so it never slows the call
async function saveTurn(s, audio, pcm) {
  if (!HD || !s.ph) return;
  if (!s.cid) { s.cid = Date.now().toString(36).padStart(8, '0'); s.tn = 0; }
  const cid = s.cid, t = ++s.tn;
  const dl = Date.now() + 45000;
  await upload(hName(s.ph, cid, 't' + t + 'q'), audio, dl, HD);
  await upload(hName(s.ph, cid, 't' + t + 'a'), pcm, dl, HD);
}
function flushSave(s) {
  const sv = s.save; s.save = null;
  if (sv && HD && s.ph) saveTurn(s, sv.audio, sv.pcm).catch(e => console.error('history save failed:', e.message));
}

// reads the file list of the history extension and groups the files of this caller into conversations, newest first
async function histList(ph, deadline) {
  const r = await http(YM + 'GetIVR2Dir?token=' + encodeURIComponent(TOKEN) + '&path=' + encodeURIComponent('ivr2:' + HD), {}, 10000, deadline);
  const j = await r.json().catch(() => ({}));
  if (j.responseStatus !== 'OK') throw new Error('history list failed ' + JSON.stringify(j).slice(0, 120));
  const txt = JSON.stringify(j);
  const re = new RegExp('p' + ph + 'c([0-9a-z]{8})(?:t(\\d+)([qa])|n)\\.wav', 'g');
  const map = new Map();
  let m;
  while ((m = re.exec(txt))) {
    const c = map.get(m[1]) || { cid: m[1], turns: {}, name: false };
    if (m[2]) { (c.turns[m[2]] = c.turns[m[2]] || {})[m[3]] = true; } else c.name = true;
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

function playConv(s) {
  const c = s.list[s.i];
  const msgs = [];
  for (const n of sortedTurns(c)) {
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
    const [qa, aa] = await Promise.all([download(hName(s.ph, c.cid, 't' + n + 'q'), dl, HD), download(hName(s.ph, c.cid, 't' + n + 'a'), dl, HD)]);
    parts.push({ text: 'שאלה קודמת של המשתמש בהקלטה:' }, { inlineData: { mimeType: 'audio/wav', data: qa.toString('base64') } });
    parts.push({ text: 'התשובה הקודמת שלך בהקלטה:' }, { inlineData: { mimeType: 'audio/wav', data: aa.toString('base64') } });
  }
  s.base = [{ role: 'user', parts }, { role: 'model', parts: [{ text: 'הבנתי אמשיך את השיחה.' }] }];
  s.h = [];
  s.cid = c.cid;
  s.tn = Math.max(...Object.keys(c.turns).map(Number));
  s.hm = 'talk';
  return askFor(s, 't-' + sp('אפשר להמשיך אני מקשיב'));
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
    for (const n of Object.keys(c.turns)) { del(hName(s.ph, c.cid, 't' + n + 'q'), HD); del(hName(s.ph, c.cid, 't' + n + 'a'), HD); }
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
    case '1': return playConv(s);
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

    if (!s.name) {
      const g = (await greetFile(s.d, Date.now() + 4000)) ? 'f-' + s.d + '/greet' : 't-' + s.g;
      return res.send(askFor(s, g));
    }
    const out = await runTurn(s, q, id, T0);
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
      const out = await runTurn(s, q, id, T0);
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
  await step('ימות: העלאה ומחיקה של קובץ', async () => {
    await upload('selftest', silent, deadline);
    const r = await http(YM + 'FileAction?token=' + encodeURIComponent(TOKEN) + '&action=delete&what=' + encodeURIComponent(yp('selftest')), {}, 8000, deadline);
    const j = await r.json().catch(() => ({}));
    if (j.responseStatus !== 'OK') throw new Error('מחיקה: ' + JSON.stringify(j).slice(0, 150));
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

app.listen(process.env.PORT || 3000, () => console.log('zygy up'));
