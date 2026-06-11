const GEMINI_API_KEY_STORAGE = 'poemlens_gemini_api_key';
const GEMINI_MODEL = 'gemini-2.5-flash';
const REQUEST_TIMEOUT_MS = 30000;
const CHAT_HISTORY_MAX_EXCHANGES = 6;
const API_KEY_TEST_DEBOUNCE_MS = 1200;
const API_KEY_TEST_MIN_INTERVAL_MS = 15000;
const API_KEY_TEST_COOLDOWN_MS = 60000;
const API_KEY_TEST_COOLDOWN_STORAGE = 'poemlens_gemini_api_key_test_cooldown_until';
const POEM_JSON_GENERATION_CONFIG = {
  temperature:0.35,
  maxOutputTokens:4096,
  responseMimeType:'application/json'
};
let geminiApiKey = sessionStorage.getItem(GEMINI_API_KEY_STORAGE) || '';
let geminiApiKeyPrompted = false;
const LOCAL_POEM_LIBRARY_VERSION = '20260604-v142-home-examples';
// 每次載入頁面都替 poems.json 自動加時間戳，避免瀏覽器吃到舊詩庫；使用者不用手動在網址後加 ?v=。
const LOCAL_POEM_LIBRARY_URL = `poems.json?v=${LOCAL_POEM_LIBRARY_VERSION}&t=${Date.now()}`;
let LOCAL_POEM_DATA = null;
let localPoemDataLoadPromise = null;
let localPoemDataLoadError = '';
let localPoemDataAttempted = false;

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function showToast(message, type = 'info') {
  const region = document.getElementById('toast-region');
  if (!region || !message) return;
  const toast = document.createElement('div');
  toast.className = `toast ${type === 'ok' ? 'ok' : (type === 'warn' ? 'warn' : '')}`;
  toast.textContent = message;
  region.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(8px)';
    setTimeout(() => toast.remove(), 220);
  }, 3600);
}

function setApiModalStatus(message, type = '') {
  const el = document.getElementById('api-key-modal-status');
  if (!el) return;
  el.className = `api-modal-status ${type}`.trim();
  el.textContent = message;
}

function openApiKeyModal(options = {}) {
  const modal = document.getElementById('api-key-modal');
  const input = document.getElementById('api-key-input');
  if (!modal || !input) return;
  input.value = sessionStorage.getItem(GEMINI_API_KEY_STORAGE) || geminiApiKey || '';
  setApiModalStatus(input.value ? '已載入本分頁暫存 key；如需驗證，重新貼上或修改 key 後會受控自動測試一次。' : '未輸入 key 時會使用本機 poems.json 詩庫。貼上 key 後會延遲自動測試一次。');
  modal.hidden = false;
  document.body.classList.add('loading-open');
  if (options.autofocus !== false) {
    setTimeout(() => input.focus(), 60);
  }
}

function closeApiKeyModal() {
  const modal = document.getElementById('api-key-modal');
  if (!modal) return;
  modal.hidden = true;
  document.body.classList.remove('loading-open');
}

async function fetchWithTimeout(resource, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(resource, { ...options, signal: controller.signal });
  } catch (e) {
    if (e?.name === 'AbortError') {
      throw new Error(`REQUEST_TIMEOUT：${Math.round(timeoutMs / 1000)} 秒內未取得回應`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

let apiKeyAutoTestTimer = null;
let apiKeyTestInFlight = false;
let lastApiKeyTestAt = 0;
let lastApiKeyTestFingerprint = '';
let lastApiKeyTestOk = false;
let apiKeyTestCooldownUntil = Number(sessionStorage.getItem(API_KEY_TEST_COOLDOWN_STORAGE) || 0);

function fingerprintGeminiApiKey(key) {
  const value = String(key || '');
  if (!value) return '';
  return `${value.length}:${value.slice(0, 6)}:${value.slice(-4)}`;
}

function getApiKeyTestCooldownRemaining() {
  return Math.max(0, apiKeyTestCooldownUntil - Date.now());
}

function scheduleGeminiApiKeyAutoTest(value) {
  clearTimeout(apiKeyAutoTestTimer);
  apiKeyAutoTestTimer = setTimeout(() => {
    runGeminiApiKeyAutoTest(value);
  }, API_KEY_TEST_DEBOUNCE_MS);
}

async function runGeminiApiKeyAutoTest(value) {
  const currentValue = (sessionStorage.getItem(GEMINI_API_KEY_STORAGE) || '').trim();
  if (!value || value !== currentValue) return;

  const fingerprint = fingerprintGeminiApiKey(value);
  if (fingerprint && fingerprint === lastApiKeyTestFingerprint && lastApiKeyTestOk) {
    setApiStatus('connected');
    setApiModalStatus('這把 Gemini API key 已測試成功；為避免重複請求，不再自動測。', 'ok');
    return;
  }

  const cooldownRemaining = getApiKeyTestCooldownRemaining();
  if (cooldownRemaining > 0) {
    setApiStatus('limited');
    setApiModalStatus(`剛遇到 Gemini 限流，暫停自動測試 ${Math.ceil(cooldownRemaining / 1000)} 秒，避免 Too many requests。`, 'warn');
    return;
  }

  const now = Date.now();
  const elapsed = now - lastApiKeyTestAt;
  if (elapsed > 0 && elapsed < API_KEY_TEST_MIN_INTERVAL_MS) {
    const waitMs = API_KEY_TEST_MIN_INTERVAL_MS - elapsed;
    setApiModalStatus(`已暫存 key；${Math.ceil(waitMs / 1000)} 秒後自動測試，避免過度請求。`);
    clearTimeout(apiKeyAutoTestTimer);
    apiKeyAutoTestTimer = setTimeout(() => runGeminiApiKeyAutoTest(value), waitMs);
    return;
  }

  if (apiKeyTestInFlight) {
    setApiModalStatus('Gemini key 測試中，暫不重複送出請求。');
    return;
  }

  apiKeyTestInFlight = true;
  lastApiKeyTestAt = Date.now();
  lastApiKeyTestFingerprint = fingerprint;
  lastApiKeyTestOk = false;
  setApiStatus('local');
  setApiModalStatus('正在輕量測試 Gemini API key，不進行內容生成...');

  try {
    const result = await testGeminiApiKey({ silent:true, promptIfMissing:false, lightweight:true });
    const latestValue = (sessionStorage.getItem(GEMINI_API_KEY_STORAGE) || '').trim();
    if (latestValue !== value) return;

    if (result.ok) {
      lastApiKeyTestOk = true;
      setApiStatus('connected');
      setApiModalStatus('Gemini API key 測試成功。之後只有需要 AI 分析時才會送出請求。', 'ok');
      showToast('Gemini API key 測試成功。', 'ok');
      return;
    }

    if (result.code === 429) {
      apiKeyTestCooldownUntil = Date.now() + API_KEY_TEST_COOLDOWN_MS;
      sessionStorage.setItem(API_KEY_TEST_COOLDOWN_STORAGE, String(apiKeyTestCooldownUntil));
      setApiStatus('limited');
      setApiModalStatus('Gemini 回覆 Too many requests；已暫停自動測試 60 秒。', 'warn');
      showToast('Gemini 暫時限流，已停止自動測試 60 秒。', 'warn');
      return;
    }

    setApiStatus('local');
    setApiModalStatus(result.message || 'Gemini API key 測試失敗，請確認 key 是否正確或 API 是否啟用。', 'warn');
  } finally {
    apiKeyTestInFlight = false;
  }
}

function handleApiKeyInput() {
  const input = document.getElementById('api-key-input');
  const value = (input?.value || '').trim();
  clearTimeout(apiKeyAutoTestTimer);

  if (!value) {
    clearGeminiApiKey();
    setApiModalStatus('已清除 key；目前會使用本機 poems.json 詩庫。');
    return;
  }

  if (value.length < 20) {
    geminiApiKey = '';
    sessionStorage.removeItem(GEMINI_API_KEY_STORAGE);
    setApiStatus('local');
    setApiModalStatus('請貼上完整 API key；目前看起來長度不足。', 'warn');
    return;
  }

  geminiApiKey = value;
  sessionStorage.setItem(GEMINI_API_KEY_STORAGE, value);
  setApiStatus('local');
  setApiModalStatus('已暫存 Gemini API key；將延遲自動測試一次，避免 Too many requests。');
  scheduleGeminiApiKeyAutoTest(value);
}

let lastFailedPoemQuery = '';

function setApiStatus(status) {
  const normalized = status === 'connected' || status === 'limited' ? status : 'local';
  const pill = document.getElementById('api-status-pill');
  if (!pill) return;
  pill.className = `api-status-pill s-${normalized}`;
  pill.textContent = normalized === 'connected'
    ? '已連線'
    : (normalized === 'limited' ? '配額受限' : '僅本機');
}

function setApiStatusFromError(e) {
  const msg = String(e?.message || '');
  if (msg.includes('API 429')) {
    setApiStatus('limited');
    return;
  }
  if (msg.includes('GEMINI_JSON_PARSE_ERROR') || msg.includes('GEMINI_BAD_POEM_TEXT')) {
    setApiStatus('connected');
    return;
  }
  if (
    msg.includes('API_KEY_MISSING') ||
    msg.includes('REQUEST_TIMEOUT') ||
    msg.includes('API 400') ||
    msg.includes('API 403') ||
    msg.includes('API 500') ||
    msg.includes('API 503') ||
    msg.includes('連線失敗')
  ) {
    setApiStatus('local');
  }
}

function getGeminiApiKey(options = {}) {
  geminiApiKey = sessionStorage.getItem(GEMINI_API_KEY_STORAGE) || geminiApiKey || '';
  if (options.promptIfMissing && (options.force || (!geminiApiKey && !geminiApiKeyPrompted))) {
    geminiApiKeyPrompted = true;
    openApiKeyModal({ autofocus:true });
  }
  return geminiApiKey.trim();
}

function promptForGeminiApiKey(force = false) {
  const hasStoredKey = Boolean(sessionStorage.getItem(GEMINI_API_KEY_STORAGE));
  if (!force && hasStoredKey) return;
  geminiApiKeyPrompted = true;
  openApiKeyModal({ autofocus:true });
}

function clearGeminiApiKey() {
  geminiApiKey = '';
  geminiApiKeyPrompted = false;
  sessionStorage.removeItem(GEMINI_API_KEY_STORAGE);
  clearTimeout(apiKeyAutoTestTimer);
  lastApiKeyTestFingerprint = '';
  lastApiKeyTestOk = false;
  setApiStatus('local');
}

async function testGeminiApiKey(options = {}) {
  const silent = Boolean(options.silent);
  const lightweight = options.lightweight !== false;
  const apiKey = getGeminiApiKey({
    promptIfMissing: options.promptIfMissing !== false,
    force: Boolean(options.force)
  });
  if (!apiKey) {
    setApiStatus('local');
    if (!silent) showToast('尚未輸入 Gemini API key；目前只能使用本機詩庫。', 'warn');
    return { ok:false, status:'local', message:'尚未輸入 API key' };
  }

  try {
    const endpoint = lightweight
      ? `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}?key=${encodeURIComponent(apiKey)}`
      : `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;

    const requestOptions = lightweight
      ? { method:'GET' }
      : {
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({
            contents:[{ parts:[{ text:'請只回覆：API_OK' }] }]
          })
        };

    const resp = await fetchWithTimeout(endpoint, requestOptions);

    let body = {};
    try { body = await resp.json(); } catch(_) {}

    if (resp.ok) {
      const text = lightweight
        ? (body?.displayName || GEMINI_MODEL)
        : (body?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '成功，但沒有文字回覆');
      setApiStatus('connected');
      if (!silent) showToast(`Gemini API 測試成功（${text}）。`, 'ok');
      return { ok:true, status:'connected', text };
    }

    const msg = body?.error?.message || `HTTP ${resp.status}`;
    const status = resp.status === 429 ? 'limited' : 'local';
    setApiStatus(status);
    if (!silent) {
      if (resp.status === 429) showToast('Gemini API 配額受限或請求過於頻繁。', 'warn');
      else if (resp.status === 400 || resp.status === 403) showToast('Gemini API key 可能無效、未啟用，或被限制。', 'warn');
      else showToast(`Gemini API 測試失敗：${resp.status}`, 'warn');
    }
    return { ok:false, status, code:resp.status, message:msg };
  } catch(e) {
    setApiStatus('local');
    const message = String(e?.message || e);
    if (!silent) showToast(`Gemini API 測試失敗：${message}`, 'warn');
    return { ok:false, status:'local', message };
  }
}

// Gemini 偶爾會回 503 / 500；這類暫時性錯誤可以退避重試。
// 429 通常是限流或配額不足，不在這裡連續重試，避免進一步消耗請求。
async function callGeminiWithRetry(contents, maxRetries = 4, requestOptions = {}) {
  const apiKey = getGeminiApiKey({ promptIfMissing:true });
  if (!apiKey) throw new Error('API_KEY_MISSING');

  const model = requestOptions.model || GEMINI_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  let lastStatus = null;
  let lastMessage = '';
  const requestBody = { contents };
  if (requestOptions.generationConfig) {
    requestBody.generationConfig = requestOptions.generationConfig;
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const resp = await fetchWithTimeout(url, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify(requestBody)
    }, requestOptions.timeoutMs || REQUEST_TIMEOUT_MS);

    if (resp.ok) {
      setApiStatus('connected');
      return await resp.json();
    }

    lastStatus = resp.status;

    try {
      const err = await resp.json();
      lastMessage = err?.error?.message || '';
    } catch(_) {
      lastMessage = '';
    }

    const retryable = [500, 503].includes(resp.status);
    if (retryable && attempt < maxRetries) {
      const backoff = 3000 * Math.pow(2, attempt);
      const jitter = Math.floor(Math.random() * 260);
      await wait(backoff + jitter);
      continue;
    }

    const detail = lastMessage ? `：${lastMessage}` : '';
    throw new Error(`API ${lastStatus}${detail}`);
  }

  const detail = lastMessage ? `：${lastMessage}` : '';
  throw new Error(`API ${lastStatus || '連線失敗'}${detail}`);
}

function friendlyApiError(e) {
  const msg = String(e?.message || '');
  if (msg.includes('API_KEY_MISSING')) {
    return '尚未輸入 Gemini API key；目前只使用本機詩庫。';
  }
  if (msg.includes('GEMINI_JSON_PARSE_ERROR')) {
    return 'Gemini 回傳的 JSON 格式不完整或被截斷；若本機詩庫沒有命中，請再試一次。';
  }
  if (msg.includes('GEMINI_BAD_POEM_TEXT')) {
    return 'Gemini 回傳的原文含亂碼或非中文內容，已拒收這次結果。';
  }
  if (msg.includes('REQUEST_TIMEOUT')) {
    return '連線逾時，請確認網路狀態，或稍後再試。';
  }
  if (msg.includes('API 503')) {
    return 'Gemini 服務暫時壅塞，已自動重試仍未成功，請稍後再試。';
  }
  if (msg.includes('API 429')) {
    return 'Gemini 請求過於頻繁或配額不足，請稍後再試。';
  }
  if (msg.includes('API 500')) {
    return 'Gemini 服務端暫時異常，請稍後再試。';
  }
  return msg || '未知錯誤';
}

function stripJsonFence(text) {
  return String(text || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
}

function extractCompleteJsonObject(text) {
  const s = stripJsonFence(text);
  const start = s.indexOf('{');
  if (start < 0) return s;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < s.length; i++) {
    const ch = s[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (ch === '\\' && inString) {
      escaped = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === '{') depth++;
    if (ch === '}') depth--;

    if (depth === 0) {
      return s.slice(start, i + 1);
    }
  }

  return s.slice(start);
}

function parseGeminiJson(text) {
  const jsonText = extractCompleteJsonObject(text);
  try {
    return JSON.parse(jsonText);
  } catch(e) {
    throw new Error(`GEMINI_JSON_PARSE_ERROR：${e.message}`);
  }
}

function isGeminiFormatError(e) {
  const msg = String(e?.message || '');
  return msg.includes('GEMINI_JSON_PARSE_ERROR') || msg.includes('GEMINI_BAD_POEM_TEXT');
}

function cjkRatio(text) {
  const chars = Array.from(String(text || '').replace(/\s+/g, ''));
  if (!chars.length) return 0;
  const cjk = chars.filter(ch => /[\u3400-\u9fff]/u.test(ch)).length;
  return cjk / chars.length;
}

function hasBadPoemText(text) {
  const raw = String(text || '');
  const compact = raw.replace(/\s+/g, '');
  if (!compact) return true;
  if (cjkRatio(compact) < 0.72) return true;
  return /[A-Za-zА-Яа-яЁё]{3,}/u.test(compact);
}

function normalizeGeminiPoemResult(r) {
  const parsed = splitPoemTextAndVariantNotes(r?.fullText || '', r?.variantNotes || []);

  if (hasBadPoemText(parsed.fullText)) {
    throw new Error('GEMINI_BAD_POEM_TEXT：Gemini 原文欄位含大量非中文或疑似亂碼');
  }

  return {
    ...r,
    fullText: parsed.fullText,
    variantNotes: parsed.variantNotes
  };
}

async function requestPoemJson(prompt, model = GEMINI_MODEL) {
  const data = await callGeminiWithRetry([{parts:[{text:prompt}]}], 4, {
    model,
    generationConfig: POEM_JSON_GENERATION_CONFIG
  });
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  return normalizeGeminiPoemResult(parseGeminiJson(text));
}

function normalizePoemQuery(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s　，。！？、；："'「」『』《》〈〉（）()·.・-]/g, '');
}

function isMostlyEnglishText(s) {
  const text = String(s || '').trim();
  if (!text) return false;
  if (/^(英譯|英文|英文譯文|English translation)/iu.test(text)) return true;
  const cjk = (text.match(/[\u3400-\u9fff]/gu) || []).length;
  const latin = (text.match(/[A-Za-z]/gu) || []).length;
  return latin >= 24 && cjk < 20 && latin > cjk * 1.15;
}

function stripLibraryHeadings(s) {
  return String(s || '')
    .replace(/\r/g, '')
    .replace(/(^|\n)\s*(譯文及注釋[一二三四五六七八九十]?|譯文[一二三四五六七八九十]?|直譯|韻譯|意譯|漢譯|注釋|註解|賞析[一二三四五六七八九十]?|鑑賞[一二三四五六七八九十]?|評析|創作背景|英文譯文|英文|英譯)\s*(?=\n|$)/gu, '\n')
    .replace(/(^|\s)(譯文及注釋[一二三四五六七八九十]?|譯文[一二三四五六七八九十]?|直譯|韻譯|意譯|漢譯|注釋|註解|賞析[一二三四五六七八九十]?|鑑賞[一二三四五六七八九十]?|評析|創作背景|英文譯文|英文|英譯)(?=\s|$)/gu, ' ');
}

function cleanPoemLibraryText(s, maxChars = 180) {
  let text = stripLibraryHeadings(s)
    .replace(/[\u200B-\u200D\uFEFF]/gu, '')
    .replace(/\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/([\u3400-\u9fff])\s+([\u3400-\u9fff])/gu, '$1$2')
    .replace(/([\u3400-\u9fff])\s+([\u3400-\u9fff])/gu, '$1$2')
    .replace(/([，。！？；：、])\s+([\u3400-\u9fff])/gu, '$1$2')
    .replace(/^[，、；：,.:。！？"'「」『』（）()\s]+/u, '')
    .trim();

  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars).replace(/[，、；：,.:\s]+$/u, '')}……`;
  }
  return text;
}

function firstLibraryText(arr, options = {}) {
  const source = Array.isArray(arr) ? arr : [arr];
  const list = source.map(x => String(x || '').trim()).filter(Boolean);
  if (options.prefer) {
    const preferred = list.find(text => options.prefer.test(text) && !isMostlyEnglishText(text));
    if (preferred) return preferred;
  }
  if (options.chineseOnly) {
    return list.find(text => !isMostlyEnglishText(text)) || '';
  }
  return list[0] || '';
}


function uniqueVariantNotes(notes = []) {
  const seen = new Set();
  return notes
    .map(note => String(note || '').trim())
    .filter(note => {
      if (!note || seen.has(note)) return false;
      seen.add(note);
      return true;
    });
}

function formatVariantNote(note) {
  const stripQuote = value => String(value || '')
    .replace(/^[「『“"']+|[」』”"']+$/gu, '')
    .trim();

  const text = String(note || '')
    .replace(/\s+/g, ' ')
    .replace(/[，,。；;]+$/u, '')
    .trim();

  if (!text) return '';

  let match = text.match(/^(.+?)\s*通\s*[:：]\s*(.+)$/u);
  if (match) {
    return `${stripQuote(match[1])}，通「${stripQuote(match[2])}」。`;
  }

  match = text.match(/^(.+?)\s*(一作|又作|或作|原作|一云|一曰)\s*[:：]\s*(.+)$/u);
  if (match) {
    const label = match[2] === '一云' || match[2] === '一曰' ? '一作' : match[2];
    return `${stripQuote(match[1])}，${label}「${stripQuote(match[3])}」。`;
  }

  return text.endsWith('。') ? text : `${text}。`;
}

function splitPoemContentAndNotes(content = []) {
  const sourceLines = Array.isArray(content)
    ? content
    : String(content || '').split(/\n+/);
  const variantNotes = [];

  const cleanContent = sourceLines
    .map(line => String(line || '')
      .replace(/\s*[（(]([^）)]*(?:一作|又作|或作|通\s*[:：]|版本|原作|一云|一曰)[^）)]*)[）)]/gu, (_, note) => {
        const formatted = formatVariantNote(note);
        if (formatted) variantNotes.push(formatted);
        return '';
      })
      .trim())
    .filter(Boolean);

  return {
    content: cleanContent,
    variantNotes: uniqueVariantNotes(variantNotes)
  };
}

function splitPoemTextAndVariantNotes(fullText = '', extraNotes = []) {
  const parsed = splitPoemContentAndNotes(String(fullText || '').split(/\n+/));
  const incomingNotes = Array.isArray(extraNotes)
    ? extraNotes
    : (extraNotes ? [extraNotes] : []);

  return {
    fullText: parsed.content.join('\n'),
    variantNotes: uniqueVariantNotes([...incomingNotes, ...parsed.variantNotes])
  };
}

function renderVariantNotes(notes = []) {
  const list = uniqueVariantNotes(notes);
  if (!list.length) return '';

  return `
    <div class="variant-notes" aria-label="校注與異文">
      <div class="variant-title">校 注 ／ 異 文</div>
      ${list.map(note => `<div class="variant-note">${escapeHTML(note)}</div>`).join('')}
    </div>
  `;
}

function parseLibraryAuthor(raw) {
  const text = String(raw || '').replace(/\r/g, '').trim();
  const parts = text.split(/[：:]/).map(p => p.replace(/\s+/g, '').trim()).filter(Boolean);
  const author = (parts.length > 1 ? parts[parts.length - 1] : text.replace(/\s+/g, '')) || '佚名';
  const dynasty = (parts.length > 1 ? parts.slice(0, -1).join('') : '')
    .replace(/代$/u, '')
    .replace(/\s+/g, '');

  return { author, dynasty };
}

function extractLibraryTranslation(item) {
  const candidates = Array.isArray(item?.translations) ? item.translations : [item?.translations];

  for (const candidate of candidates) {
    const raw = String(candidate || '').replace(/\r/g, '').trim();
    if (!raw || isMostlyEnglishText(raw)) continue;

    const match = raw.match(/(?:^|\n)\s*(?:譯文[一二三四五六七八九十]?|直譯|韻譯|意譯|漢譯)\s*\n([\s\S]*?)(?=\n\s*(?:注釋|註解|賞析|鑑賞|評析|譯文及注釋[一二三四五六七八九十]?|譯文[一二三四五六七八九十]?|英文譯文|英文|英譯)\s*(?:\n|$)|$)/u);
    let section = match ? match[1] : raw;
    section = section
      .replace(/[\u200B-\u200D\uFEFF]*\s*(?:注釋|註解)\s*[\s\S]*$/u, '')
      .replace(/\n\s*(?:注釋|註解)[\s\S]*$/u, '');
    const cleaned = cleanPoemLibraryText(section, 10000);

    if (cleaned && !isMostlyEnglishText(cleaned)) return cleaned;
  }

  return '';
}

function extractLibraryAnalysis(item) {
  return cleanPoemLibraryText(firstLibraryText(item.analyses, { chineseOnly: true }), 10000);
}

function extractLibraryHistory(item) {
  const raw = firstLibraryText(item.others, { prefer: /創作背景/u, chineseOnly: true });
  if (!raw || isMostlyEnglishText(raw)) return '';
  return cleanPoemLibraryText(raw, 10000);
}

function inferLibraryDevices(item) {
  const lines = splitPoemContentAndNotes(item.content).content;
  const firstLine = normalizePoemQuery(lines[0] || '');
  const charCount = Array.from(firstLine).length;
  const devices = [];

  if (charCount === 5) devices.push(lines.length >= 8 ? '五言律詩' : '五言絕句');
  else if (charCount === 7) devices.push(lines.length >= 8 ? '七言律詩' : '七言絕句');
  else devices.push('古典詩詞');

  const joined = lines.join('');
  if (/[山水江河月雲風雨花鳥]/u.test(joined)) devices.push('意象鋪陳');
  if (/[愁恨淚別思憶]/u.test(joined)) devices.push('借景抒情');
  if (/[上下天地古今]/u.test(joined)) devices.push('時空對照');

  return [...new Set(devices)].slice(0, 3);
}

function inferLibraryEmotion(item) {
  const cleanLines = splitPoemContentAndNotes(item.content).content;
  const text = `${item.title || ''}${cleanLines.join('')}${firstLibraryText(item.analyses)}`;
  let primary = '含蓄詩情';
  let intensity = '中等';
  let modernEcho = '像在日常片刻中忽然被一句話照見心事，安靜卻久久不散。';

  if (/[邊塞征戰胡馬沙場烽火]/u.test(text)) {
    primary = '悲壯'; intensity = '高昂';
    modernEcho = '像看見遠方危局時，心中同時生出牽掛與守護的願望。';
  } else if (/[故鄉鄉思歸夢客舍]/u.test(text)) {
    primary = '思鄉'; intensity = '深切';
    modernEcho = '像異地深夜突然想起家裡的燈，還未開口，思念已經先到。';
  } else if (/[別離送別離人]/u.test(text)) {
    primary = '離情'; intensity = '含蓄深長';
    modernEcho = '像送人離站後，人潮散去，心裡仍留著剛才那一句珍重。';
  } else if (/[春花落風雨]/u.test(text)) {
    primary = '惜春'; intensity = '輕柔';
    modernEcho = '像雨後看見滿地落花，才驚覺時間已悄悄走遠。';
  } else if (/[山水空禪鳥月溪]/u.test(text)) {
    primary = '清幽'; intensity = '淡遠';
    modernEcho = '像關掉喧鬧通知後，才聽見空氣裡細小而安定的聲音。';
  }

  return {
    primary,
    intensity,
    analysis: extractLibraryAnalysis(item) || `《${item.title}》以原文意象推進情緒，讓景物與心境互相映照。讀者可先抓住詩中反覆出現的景物，再回看詩人真正不忍明說的心事。`,
    modernEcho
  };
}

function libraryItemToRenderPoem(item) {
  const { author, dynasty } = parseLibraryAuthor(item.author);
  const parsedContent = splitPoemContentAndNotes(item.content);
  const lines = parsedContent.content;
  const fullText = lines.join('\n');
  const analysis = extractLibraryAnalysis(item);
  const history = extractLibraryHistory(item);

  return {
    title: item.title || '未題',
    author,
    dynasty,
    fullText,
    variantNotes: parsedContent.variantNotes,
    monologue: `吾作《${item.title || '此詩'}》，把「${lines[0] || '眼前景'}」藏入開篇，又讓「${lines[lines.length - 1] || '心中意'}」收束餘韻。汝若問此詩，先從景中看情，再從短句裡聽未盡之聲。`,
    semantic: {
      translation: extractLibraryTranslation(item) || `本機詩庫收錄《${item.title || '此詩'}》原文。此處未附完整譯文，可先依詩句意象理解其情境與轉折。`,
      devices: inferLibraryDevices(item)
    },
    emotion: inferLibraryEmotion(item),
    history: {
      context: history || analysis || `此詩出自本機詩詞資料庫。資料含原文與賞析欄位，可作為離線查詩與 API 限流時的備援來源。`,
      source: '本機詩庫 poems.json'
    }
  };
}

function scoreLibraryPoem(item, q, loose = false) {
  const { author, dynasty } = parseLibraryAuthor(item.author);
  const title = normalizePoemQuery(item.title);
  const writer = normalizePoemQuery(author);
  const era = normalizePoemQuery(dynasty);
  const lines = splitPoemContentAndNotes(item.content).content.map(normalizePoemQuery).filter(Boolean);
  const fullText = normalizePoemQuery(lines.join(''));
  let score = 0;

  if (q === title) score = Math.max(score, 180);
  else if (title.includes(q) && q.length >= 2) score = Math.max(score, 130 + q.length);
  else if (q.includes(title) && title.length >= 2) score = Math.max(score, 115 + title.length);

  lines.forEach(line => {
    if (q === line) score = Math.max(score, 170);
    else if (line.includes(q) && q.length >= 2) score = Math.max(score, 145 + q.length);
    else if (q.includes(line) && line.length >= 4) score = Math.max(score, 120 + line.length);
  });

  if (writer && q === writer) score = Math.max(score, 90);
  else if (writer && (q.includes(writer) || writer.includes(q)) && q.length >= 2) score = Math.max(score, 70);
  if (era && q === era) score = Math.max(score, 40);

  if (loose && fullText.includes(q) && q.length >= 2) score = Math.max(score, 80 + q.length);

  return score;
}

function normalizeLocalPoemLibrary(raw) {
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.data)) return raw.data;
  if (Array.isArray(raw?.poems)) return raw.poems;
  return [];
}

async function ensureLocalPoemDataLoaded() {
  if (localPoemDataAttempted && Array.isArray(LOCAL_POEM_DATA)) return LOCAL_POEM_DATA;
  if (Array.isArray(LOCAL_POEM_DATA) && LOCAL_POEM_DATA.length) return LOCAL_POEM_DATA;
  if (localPoemDataLoadPromise) return localPoemDataLoadPromise;

  localPoemDataLoadPromise = (async () => {
    localPoemDataAttempted = true;
    try {
      const resp = await fetchWithTimeout(LOCAL_POEM_LIBRARY_URL, { cache:'no-store' });
      if (!resp.ok) throw new Error(`LOCAL_POEM_LIBRARY_HTTP_${resp.status}`);
      const json = await resp.json();
      LOCAL_POEM_DATA = normalizeLocalPoemLibrary(json);
      localPoemDataLoadError = '';
      return LOCAL_POEM_DATA;
    } catch (e) {
      LOCAL_POEM_DATA = [];
      localPoemDataLoadError = String(e?.message || e || 'LOCAL_POEM_LIBRARY_LOAD_FAILED');
      return LOCAL_POEM_DATA;
    } finally {
      localPoemDataLoadPromise = null;
    }
  })();

  return localPoemDataLoadPromise;
}

function getLibraryPoemFromLoadedData(input, options = {}) {
  const q = normalizePoemQuery(input);
  if (!q || !Array.isArray(LOCAL_POEM_DATA) || !LOCAL_POEM_DATA.length) return null;

  const loose = Boolean(options.loose);
  let best = null;

  LOCAL_POEM_DATA.forEach((item, index) => {
    const score = scoreLibraryPoem(item, q, loose);
    if (score && (!best || score > best.score || (score === best.score && index < best.index))) {
      best = { item, score, index };
    }
  });

  return best ? libraryItemToRenderPoem(best.item) : null;
}

async function getLibraryPoem(input, options = {}) {
  const data = await ensureLocalPoemDataLoaded();
  if (!data.length) return null;
  return getLibraryPoemFromLoadedData(input, options);
}

async function getLocalPoem(input, options = {}) {
  return await getLibraryPoem(input, options);
}


function chooseRandomLibraryItem(data) {
  const usable = (Array.isArray(data) ? data : []).filter(item => {
    return item && item.title && Array.isArray(item.content) && item.content.length;
  });
  if (!usable.length) return null;
  const index = Math.floor(Math.random() * usable.length);
  return usable[index];
}

async function randomPoem() {
  const btn = document.getElementById('random-btn');
  const output = document.getElementById('output');
  if (btn) btn.disabled = true;
  if (output) output.innerHTML = '';

  try {
    const data = await ensureLocalPoemDataLoaded();
    const item = chooseRandomLibraryItem(data);
    if (!item) {
      if (output) {
        const hint = localPoemDataLoadError
          ? '請確認 poems.json 已與 index.html 放在同一層，並使用 localhost 或 GitHub Pages 開啟。'
          : '目前本機詩庫沒有可抽取的作品。';
        output.innerHTML = `<div class="error"><div class="error-title">本 機 詩 庫 暫 時 無 法 隨 機 召 喚</div><div class="error-detail">${escapeHTML(hint)}</div></div>`;
      }
      showToast('本機詩庫尚未載入，無法隨機召喚。', 'warn');
      return;
    }

    const poem = libraryItemToRenderPoem(item);
    render(poem, { source:'local' });
    showLocalLibraryNotice();
    // 隨機召喚只使用本機詩庫，不應改變 Gemini API 連線狀態。
    // 若使用者原本已連線，左側狀態需維持「已連線」。
    showToast(`已隨機召喚：${poem.title}`, 'ok');
    setTimeout(() => {
      const poemCard = document.querySelector('.poem-scroll') || document.getElementById('output');
      smoothScrollToElement(poemCard, { block:'start', duration:920 });
    }, 160);
  } finally {
    if (btn) btn.disabled = false;
  }
}

let activeSpeechButton = null;
let activeSpeechText = '';

function normalizeSpeechText(text) {
  return String(text || '')
    .replace(/[\t ]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function getChineseSpeechVoice() {
  if (!('speechSynthesis' in window)) return null;
  const voices = window.speechSynthesis.getVoices?.() || [];
  return voices.find(v => v.lang === 'zh-TW')
    || voices.find(v => /zh[-_]?Hant/i.test(v.lang))
    || voices.find(v => /^zh/i.test(v.lang))
    || voices[0]
    || null;
}

function setSpeechButtonState(button, state) {
  if (!button) return;
  if (!button.dataset.idleLabel) button.dataset.idleLabel = button.textContent.trim() || '朗 讀';
  button.classList.remove('loading', 'playing');
  button.disabled = false;

  if (state === 'loading') {
    button.classList.add('loading');
    button.textContent = '準 備';
  } else if (state === 'playing') {
    button.classList.add('playing');
    button.textContent = '停 止';
  } else {
    button.textContent = button.dataset.idleLabel;
  }
}

function resetSpeechButtons() {
  document.querySelectorAll('.tts-btn').forEach(btn => setSpeechButtonState(btn, 'idle'));
}

function stopBrowserSpeech() {
  if ('speechSynthesis' in window) {
    window.speechSynthesis.cancel();
  }
  activeSpeechButton = null;
  activeSpeechText = '';
  resetSpeechButtons();
}

function speakWithBrowser(text, button) {
  const cleanText = normalizeSpeechText(text);
  if (!cleanText) {
    showToast('目前沒有可朗讀的文字。', 'warn');
    return;
  }
  if (!('speechSynthesis' in window) || typeof SpeechSynthesisUtterance === 'undefined') {
    showToast('此瀏覽器不支援內建朗讀，建議改用 Chrome 或 Edge。', 'warn');
    return;
  }

  if (activeSpeechButton === button && activeSpeechText === cleanText && button?.classList.contains('playing')) {
    stopBrowserSpeech();
    return;
  }

  stopBrowserSpeech();
  activeSpeechButton = button || null;
  activeSpeechText = cleanText;
  setSpeechButtonState(button, 'loading');

  const utterance = new SpeechSynthesisUtterance(cleanText);
  utterance.lang = 'zh-TW';
  utterance.rate = 0.85;
  utterance.pitch = 1;
  utterance.volume = 1;
  const voice = getChineseSpeechVoice();
  if (voice) utterance.voice = voice;

  utterance.onstart = () => setSpeechButtonState(button, 'playing');
  utterance.onend = () => {
    if (activeSpeechButton === button) stopBrowserSpeech();
  };
  utterance.onerror = () => {
    if (activeSpeechButton === button) stopBrowserSpeech();
    showToast('朗讀被中止或無法播放。', 'warn');
  };

  window.speechSynthesis.speak(utterance);
  setTimeout(() => {
    if (activeSpeechButton === button && button?.classList.contains('loading')) {
      setSpeechButtonState(button, 'playing');
    }
  }, 350);
}

function speakCurrentPoem(button) {
  speakWithBrowser(currentPoem?.fullText || '', button);
}

function speakCurrentMonologue(button) {
  const typedText = document.getElementById('tw-span')?.textContent || '';
  speakWithBrowser(currentPoem?.monologue || typedText, button);
}
function appendPoemNotice(text) {
  const poemCard = document.querySelector('.poem-scroll');
  if (!poemCard) return;
  const note = document.createElement('div');
  note.className = 'src-note';
  note.textContent = text;
  poemCard.appendChild(note);
}

function showLocalLibraryNotice() {
  const count = Array.isArray(LOCAL_POEM_DATA) ? LOCAL_POEM_DATA.length : 0;
  if (count > 0) {
    appendPoemNotice(`本機詩庫：已從 poems.json 載入 ${count} 首詩詞資料，未消耗 Gemini API。`);
    return;
  }
  appendPoemNotice(`本機詩庫：poems.json 尚未載入或無可用資料，未使用內建假資料。`);
}

function showFallbackNotice(e) {
  const loadHint = localPoemDataLoadError ? ` 本機詩庫載入狀態：${localPoemDataLoadError}` : '';
  appendPoemNotice(`本機詩庫備援：Gemini 暫時無法回應，已先用本機詩詞資料召回詩魂。${friendlyApiError(e)}${loadHint}`);
}
function showLocalRecommendNotice(query) {
  appendPoemNotice(`本機推薦：依「${query}」關鍵字相近度顯示，未消耗 Gemini API。`);
}

function renderActionableErrorCard(query, err) {
  const output = document.getElementById('output');
  if (!output) return;
  const safeQuery = escapeHTML(query || '');
  output.innerHTML = `
    <div class="error">
      <div class="error-title">詩 魂 今 夜 未 現，請 再 試 一 次</div>
      <div class="error-detail" id="error-detail">${escapeHTML(friendlyApiError(err))}</div>
      <div class="error-query">查 詢：${safeQuery || '（無）'}</div>
      <div class="error-actions">
        <button class="error-btn" type="button" data-action="retry-summon">重新查詢 Gemini</button>
        <button class="error-btn" type="button" data-action="switch-api-key">切換新的 API Key</button>
        <button class="error-btn" type="button" data-action="recommend-local-similar">查找本機相近詩詞</button>
        <button class="error-btn" type="button" data-action="random-poem">隨機召喚</button>
        <button class="error-btn" type="button" data-action="focus-poem-input">返回輸入</button>
      </div>
    </div>`;
}

function retrySummonFromError() {
  const input = document.getElementById('poem-input');
  if (input && lastFailedPoemQuery) input.value = lastFailedPoemQuery;
  summon();
}

function switchApiKeyFromError() {
  clearGeminiApiKey();
  promptForGeminiApiKey(true);
}

async function recommendLocalSimilarFromError() {
  const input = document.getElementById('poem-input');
  const query = (input?.value || lastFailedPoemQuery || '').trim();
  if (!query) return;

  const localPoem = await getLocalPoem(query, { loose:true });
  if (!localPoem) {
    const detail = document.getElementById('error-detail');
    if (detail) {
      const suffix = localPoemDataLoadError
        ? `（poems.json 載入失敗：${localPoemDataLoadError}）`
        : '';
      detail.textContent = `本機詩庫目前沒有收錄「${query}」的明確相近作品。可改輸入詩名、作者或完整詩句片段；若要查本機詩庫外的作品，請使用 Gemini 查詢，或先隨機召喚一首本機詩。${suffix}`;
      showToast('本機詩庫沒有明確相近作品，可改用 Gemini 或隨機召喚。', 'warn');
    }
    return;
  }
  render(localPoem, { source:'local' });
  showLocalRecommendNotice(query);
  // 推薦本機相近作品不應覆蓋既有 Gemini API 狀態。
  setTimeout(() => {
    const poemCard = document.querySelector('.poem-scroll') || document.getElementById('output');
    smoothScrollToElement(poemCard, { block:'start', duration:920 });
  }, 160);
}

// ══ 柔順捲動工具 ══
function smoothScrollToElement(el, options = {}) {
  if (!el) return;

  const {
    block = 'start',
    duration = 760,
    extraOffset = 0
  } = options;

  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (reduceMotion) {
    el.scrollIntoView({ block, behavior: 'auto' });
    return;
  }

  const rect = el.getBoundingClientRect();
  const startY = window.scrollY || window.pageYOffset;
  const viewportH = window.innerHeight;
  const mobileOffset = window.innerWidth <= 900 ? 78 : 18;

  let targetY;
  if (block === 'center') {
    targetY = startY + rect.top - (viewportH / 2) + (rect.height / 2) - extraOffset;
  } else {
    targetY = startY + rect.top - mobileOffset - extraOffset;
  }

  targetY = Math.max(0, targetY);

  const distance = targetY - startY;
  if (Math.abs(distance) < 2) return;

  const startTime = performance.now();
  const easeInOutCubic = t => (
    t < 0.5
      ? 4 * t * t * t
      : 1 - Math.pow(-2 * t + 2, 3) / 2
  );

  function animate(now) {
    const elapsed = now - startTime;
    const t = Math.min(elapsed / duration, 1);
    const y = startY + distance * easeInOutCubic(t);
    window.scrollTo(0, y);

    if (t < 1) requestAnimationFrame(animate);
  }

  requestAnimationFrame(animate);
}

// 新內容出現時的柔順跟隨。
// 只在內容不夠完整地出現在畫面中時才捲動，避免太頻繁干擾使用者。
function smoothFollowNewContent(el, options = {}) {
  if (!el) return;

  const {
    duration = 760,
    block = 'end',
    extraOffset = 18
  } = options;

  const rect = el.getBoundingClientRect();
  const viewportTop = window.innerWidth <= 900 ? 82 : 24;
  const viewportBottom = window.innerHeight - 28;

  const alreadyComfortablyVisible =
    rect.top >= viewportTop &&
    rect.bottom <= viewportBottom;

  if (alreadyComfortablyVisible) return;

  // 新內容通常要讓底部自然進入視線，閱讀時比較順。
  if (block === 'end') {
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion) {
      el.scrollIntoView({ block:'end', behavior:'auto' });
      return;
    }

    const startY = window.scrollY || window.pageYOffset;
    const targetY = Math.max(
      0,
      startY + rect.bottom - window.innerHeight + extraOffset
    );
    const distance = targetY - startY;
    if (Math.abs(distance) < 2) return;

    const startTime = performance.now();
    const easeInOutCubic = t => (
      t < 0.5
        ? 4 * t * t * t
        : 1 - Math.pow(-2 * t + 2, 3) / 2
    );

    function animate(now) {
      const elapsed = now - startTime;
      const t = Math.min(elapsed / duration, 1);
      window.scrollTo(0, startY + distance * easeInOutCubic(t));
      if (t < 1) requestAnimationFrame(animate);
    }

    requestAnimationFrame(animate);
    return;
  }

  smoothScrollToElement(el, { block, duration, extraOffset });
}

// ══ 頁面切換 ══
function showPage(id, tab) {
  stopBrowserSpeech();
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));

  const page = document.getElementById(id);
  page.classList.add('active');
  tab.classList.add('active');

  if (id === 'p3') renderCollection();

  // 切換不同功能頁時，柔順移到該頁開頭
  requestAnimationFrame(() => {
    smoothScrollToElement(page, { block:'start', duration:680 });
  });
}

// ══ 收藏 ══
let collection = JSON.parse(localStorage.getItem('poemlens_col') || '[]');
let currentPoem = {};

function saveCol() {
  localStorage.setItem('poemlens_col', JSON.stringify(collection));
  document.getElementById('collect-badge').textContent = collection.length;
}

async function copyCurrentPoem() {
  if (!currentPoem?.title) {
    showToast('目前沒有可複製的詩作。', 'warn');
    return;
  }

  const lines = [
    currentPoem.title,
    `${currentPoem.dynasty || ''}・${currentPoem.author || ''}`.replace(/^・|・$/g, ''),
    '',
    currentPoem.fullText || ''
  ];
  const text = lines.join('\n').trim();

  try {
    await navigator.clipboard.writeText(text);
    showToast('詩作已複製。', 'ok');
  } catch (_) {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.left = '-9999px';
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    area.remove();
    showToast('詩作已複製。', 'ok');
  }
}

function toggleSave() {
  const btn = document.getElementById('save-btn');
  if (!btn) return;
  const idx = collection.findIndex(p => p.title === currentPoem.title);
  if (idx >= 0) {
    collection.splice(idx, 1);
    btn.textContent = '收 藏'; btn.classList.remove('saved');
  } else {
    collection.push({ ...currentPoem, savedAt: Date.now() });
    btn.textContent = '已 收 藏'; btn.classList.add('saved');
  }
  saveCol();
}

function renderCollection() {
  const el = document.getElementById('col-content');
  if (!collection.length) {
    el.innerHTML = '<div class="col-empty">— 尚 未 收 藏 任 何 詩 作 —<br><br><span style="font-size:12px">去「通靈問詩」找一首吧</span></div>';
    return;
  }
  el.innerHTML = `<div class="col-grid">${collection.map((p,i) => `
    <div class="col-card" data-action="load-poem" data-index="${i}">
      <button class="col-del" data-action="delete-collection" data-index="${i}" type="button">✕</button>
      <div class="col-title">${escapeHTML(p.title)}</div>
      <div class="col-meta">${escapeHTML(p.author)} ・ ${escapeHTML(p.dynasty)}</div>
      <div class="col-preview">${escapeHTML(p.fullText?.replace(/\n/g,'　'))}</div>
    </div>`).join('')}</div>`;
}

function delCol(e, i) {
  e.stopPropagation();
  collection.splice(i, 1);
  saveCol(); renderCollection();
}

function loadPoem(i) {
  const p = collection[i];
  showPage('p1', document.querySelector('.nav-tab[data-page="p1"]'));
  setTimeout(() => {
    render(p, { source: p.source || 'gemini' });
    setTimeout(() => {
      const poemCard = document.querySelector('.poem-scroll');
      smoothScrollToElement(poemCard, { block:'start', duration:900 });
    }, 120);
  }, 100);
}

// 初始化
document.getElementById('collect-badge').textContent = collection.length;

// ══ 頁面1：分析 ══
function fill(t, btn) {
  document.getElementById('poem-input').value = t;
  document.querySelectorAll('.ex-btn').forEach(b => b.classList.remove('active'));
  if(btn) btn.classList.add('active');

  // 按下範例按鈕後，自動滑動到「焚 香 問 詩」出現在畫面中
  setTimeout(() => {
    const submitBtn = document.getElementById('submit-btn');
    smoothScrollToElement(submitBtn, { block:'center', duration:720 });
  }, 120);
}

const loadingMsgs = ['點 燃 香 爐 ⋯', '翻 閱 古 卷 ⋯', '召 喚 詩 魂 ⋯', '詩 人 正 在 回 應 ⋯'];
let loadTimer = null;

function startLoading() {
  const box = document.getElementById('loading');
  const txt = document.getElementById('loading-text');
  box.classList.add('show');
  document.body.classList.add('loading-open');

  let i = 0; 
  txt.textContent = loadingMsgs[0];

  loadTimer = setInterval(() => {
    i = (i+1) % loadingMsgs.length;
    txt.style.animation = 'none'; 
    txt.offsetHeight;
    txt.style.animation = 'fadeUp 1s';
    txt.textContent = loadingMsgs[i];
  }, 1300);
}

function stopLoading() {
  clearInterval(loadTimer);
  document.getElementById('loading').classList.remove('show');
  document.body.classList.remove('loading-open');
}

async function summon() {
  const input = document.getElementById('poem-input').value.trim();
  const output = document.getElementById('output');
  const btn = document.getElementById('submit-btn');
  if (!input) { output.innerHTML = '<div class="error">心 中 須 有 所 念</div>'; return; }
  btn.disabled = true; output.innerHTML = '';

  const localPoem = await getLocalPoem(input);
  if (localPoem) {
    render(localPoem, { source:'local' });
    showLocalLibraryNotice();
    // 本機命中只代表資料來源為 poems.json，不代表 Gemini API 斷線。
    setTimeout(() => {
      const poemCard = document.querySelector('.poem-scroll') || document.getElementById('output');
      smoothScrollToElement(poemCard, { block:'start', duration:920 });
    }, 160);
    btn.disabled = false;
    return;
  }

  startLoading();

  const prompt = `你是中國古典詩詞資料查詢器。使用者輸入可能是作者名、詩句片段、詩名或意境描述。
使用者輸入：「${input}」
嚴格只回傳一個 JSON object，不要 markdown 標記，不要額外解釋。
fullText 只能放詩詞原文，不可放翻譯、注釋、英文、拼音、賞析或資料來源；若有「一作／又作／通」等校勘文字，放到 variantNotes。
variantNotes：只放異文或校勘註，可為空陣列。
所有說明欄位保持精簡，避免長篇賞析。
monologue：詩人第一人稱半文半白獨白，30-55字。
modernEcho：現代生活情境類比，15-30字。
{
  "title":"詩名","author":"作者","dynasty":"朝代",
  "fullText":"原文句間用\\n",
  "variantNotes":["校勘註，可空陣列"],
  "monologue":"詩人獨白",
  "semantic":{"translation":"白話翻譯40-70字","devices":["修辭1","修辭2","體裁"]},
  "emotion":{"primary":"主要情緒","intensity":"強度","analysis":"情緒分析35-65字","modernEcho":"現代類比"},
  "history":{"context":"創作背景40-70字","source":"典籍出處"}
  }`;

  try {
    const r = await requestPoemJson(prompt, GEMINI_MODEL);
    stopLoading();
    render(r, { source:'gemini' });
    setTimeout(() => {
      const poemCard = document.querySelector('.poem-scroll') || document.getElementById('output');
      smoothScrollToElement(poemCard, { block:'start', duration:920 });
    }, 160);
  } catch(e) {
    setApiStatusFromError(e);
    stopLoading();
    const fallbackPoem = await getLocalPoem(input, { loose:true });
    if (fallbackPoem) {
      render(fallbackPoem, { source:'local' });
      showFallbackNotice(e);
      setTimeout(() => {
        const poemCard = document.querySelector('.poem-scroll') || document.getElementById('output');
        smoothScrollToElement(poemCard, { block:'start', duration:920 });
      }, 160);
    } else {
      lastFailedPoemQuery = input;
      renderActionableErrorCard(input, e);
    }
  } finally { btn.disabled = false; }
}


function getPoemLayoutMode(rawText = '') {
  // 延續 v1.4.1：原詩一律保留直排。
  // 長詩不再自動切成橫排，而是讓原文白色方框依最長詩句垂直伸縮，
  // 並保留橫向捲動，兼顧古典直排感與長篇閱讀穩定性。
  return 'vertical';
}

function render(r, options = {}) {
  stopBrowserSpeech();
  const sourceKind = options.source === 'local' ? 'local' : 'gemini';
  const sourceText = sourceKind === 'local' ? '本機詩庫' : 'Gemini';
  const parsedPoemText = splitPoemTextAndVariantNotes(r.fullText || '', r.variantNotes || []);
  const displayFullText = parsedPoemText.fullText;
  const variantNotesHtml = renderVariantNotes(parsedPoemText.variantNotes);
  const poemLayoutMode = getPoemLayoutMode(displayFullText);

  currentPoem = {
    title:r.title,
    author:r.author,
    dynasty:r.dynasty,
    fullText:displayFullText,
    variantNotes:parsedPoemText.variantNotes,
    monologue:r.monologue || '',
    semantic:r.semantic,
    emotion:r.emotion,
    history:r.history,
    source: sourceKind
  };
  const saved = collection.findIndex(p => p.title === r.title) >= 0;
  const devs = (r.semantic?.devices||[]).map((d,i)=>`<span class="tag-item t${(i%3)+1}">${escapeHTML(d)}</span>`).join('');

  document.getElementById('output').innerHTML = `
    <div class="poem-scroll">
      <div class="poem-overview-grid">
        <section class="poem-original-panel">
          <div class="poem-panel-top">
            <div class="poem-panel-label">— 詩 作 原 文 —</div>
            <button class="tts-btn" type="button" data-action="speak-poem" data-idle-label="朗 讀">朗 讀</button>
            <div class="font-size-controls" aria-label="調整詩文字大小">
              <button class="font-size-btn" type="button" data-action="change-poem-font" data-delta="-1" title="縮小字體">字 小</button>
              <span class="font-size-value" id="poem-font-size-value">20</span>
              <button class="font-size-btn" type="button" data-action="change-poem-font" data-delta="1" title="放大字體">字 大</button>
            </div>
          </div>
          <div class="poem-text-wrap layout-${poemLayoutMode}"><div class="poem-text layout-${poemLayoutMode}">${escapeHTML(displayFullText)}</div></div>
          ${variantNotesHtml}
        </section>

        <section class="poem-head poem-title-card">
          <div class="poem-head-main">
            <div class="title-panel-top">
              <div class="reveal-label">— 詩 魂 現 身 —</div>
              <div class="font-size-controls title-font-controls" aria-label="調整篇名字大小">
                <button class="font-size-btn" type="button" data-action="change-title-font" data-delta="-1" title="縮小篇名">字 小</button>
                <span class="font-size-value" id="title-font-size-value">34</span>
                <button class="font-size-btn" type="button" data-action="change-title-font" data-delta="1" title="放大篇名">字 大</button>
              </div>
            </div>

            <div class="poem-title-card-body">
              <div class="poem-title">${escapeHTML(r.title)}</div>
              <div class="poem-meta-info">${escapeHTML(r.author)} ・ ${escapeHTML(r.dynasty)}</div>
            </div>
          </div>

          <div class="poem-head-bottom">
            <div class="poem-source-note source-${sourceKind}">來源：${sourceText}</div>
            <div class="poem-head-right">
              <button class="copy-btn" type="button" data-action="copy-poem">複 製</button>
              <button class="save-btn ${saved?'saved':''}" id="save-btn" data-action="toggle-save" type="button">${saved?'已 收 藏':'收 藏'}</button>
            </div>
          </div>
        </section>
      </div>

      <section class="monologue-wrap" id="monologue-wrap">
        <div class="monologue-title-row">
          <div class="monologue-label">— 詩 魂 自 語 —</div>
          <button class="tts-btn" type="button" data-action="speak-monologue" data-idle-label="朗 讀">朗 讀</button>
        </div>
      </section>

      <div class="completion-seal">已 通 靈</div>
    </div>
    <div class="tabs">
      <button class="tab active" type="button" data-action="switch-tab" data-tab="sem">詩 魂 自 述</button>
      <button class="tab" type="button" data-action="switch-tab" data-tab="emo">心 緒 透 視</button>
      <button class="tab" type="button" data-action="switch-tab" data-tab="his">魂 歸 何 處</button>
    </div>
    <div id="tab-sem" class="tab-content active">
      <div class="sec-label">— 白 話 釋 義 —</div>
      <div class="sec-txt sentence-break">${formatProse(r.semantic?.translation||'')}</div>
      <div class="sec-label">— 修 辭 與 體 裁 —</div>
      <div class="sec-tags">${devs}</div>
    </div>
    <div id="tab-emo" class="tab-content">
      <div class="emo-row">
        <div class="emo-cell"><div class="el">主要情緒</div><div class="ev">${escapeHTML(r.emotion?.primary||'')}</div></div>
        <div class="emo-cell"><div class="el">情緒強度</div><div class="ev">${escapeHTML(r.emotion?.intensity||'')}</div></div>
      </div>
      <div class="sec-label">— 情 緒 層 次 —</div>
      <div class="sec-txt sentence-break">${formatProse(r.emotion?.analysis||'')}</div>
      <div class="echo-box">
        <div class="echo-lbl">— 現 代 回 聲 —</div>
        <div class="echo-txt">${escapeHTML(r.emotion?.modernEcho||'')}</div>
      </div>
    </div>
    <div id="tab-his" class="tab-content">
      <div class="sec-label">— 創 作 背 景 —</div>
      <div class="sec-txt sentence-break">${formatProse(r.history?.context||'')}</div>
      <div class="src-note">典 籍 可 考：${escapeHTML(r.history?.source||'')}</div>
    </div>
    <div class="chat-section" id="chat-section">
      <div class="chat-label">— 向 詩 魂 提 問 —</div>
      <div class="chat-messages" id="chat-messages"></div>
      <div class="chat-input-wrap">
        <input class="chat-input" id="chat-input" placeholder="問詩人任何問題…"/>
        <button class="chat-send" id="chat-send" type="button" data-action="send-chat">問 之</button>
      </div>
    </div>`;

  // 依作品長度與版面寬度，自動調整直排詩文高度
  requestAnimationFrame(() => {
    applyPoemFontSize();
    applyTitleFontSize();
    fitPoemLayout();
    fitPoemTitleLayout();

    if (document.fonts?.ready) {
      document.fonts.ready.then(() => {
        applyPoemFontSize();
        applyTitleFontSize();
        fitPoemLayout();
        fitPoemTitleLayout();
      });
    }
  });

  // 打字機獨白
  if (r.monologue) startTypewriter(r.monologue);

  // 初始化對談
  initChat(currentPoem);

  // Enter 送出
  document.getElementById('chat-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendQ(); }
  });
}

let poemResizeTimer = null;

let poemFontSize = Number(localStorage.getItem('poemlens_poem_font_size_v141') || 20);
let titleFontSize = Number(localStorage.getItem('poemlens_title_font_size_v141') || 34);

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function applyPoemFontSize() {
  poemFontSize = clamp(poemFontSize, 16, 28);
  document.documentElement.style.setProperty('--dynamic-poem-font-size', `${poemFontSize}px`);

  const textEl = document.querySelector('.poem-text');
  if (textEl) {
    const adjustedSize = textEl.classList.contains('layout-horizontal')
      ? clamp(poemFontSize - 2, 15, 24)
      : poemFontSize;
    textEl.style.fontSize = `${adjustedSize}px`;
  }

  const label = document.getElementById('poem-font-size-value');
  if (label) label.textContent = poemFontSize;

  localStorage.setItem('poemlens_poem_font_size_v141', poemFontSize);
  fitPoemLayout();
}

function applyTitleFontSize() {
  titleFontSize = clamp(titleFontSize, 22, 38);

  const titleEl = document.querySelector('.poem-title');
  if (titleEl) titleEl.style.fontSize = `${titleFontSize}px`;

  // 作者朝代跟著篇名字級小幅調整，保持比例
  const metaEl = document.querySelector('.poem-meta-info');
  if (metaEl) {
    const metaSize = clamp(Math.round(titleFontSize * 0.54), 12, 20);
    metaEl.style.fontSize = `${metaSize}px`;
  }

  const label = document.getElementById('title-font-size-value');
  if (label) label.textContent = titleFontSize;

  localStorage.setItem('poemlens_title_font_size_v141', titleFontSize);
  fitPoemTitleLayout();
}

function changePoemFontSize(delta) {
  poemFontSize += delta;
  applyPoemFontSize();
}

function changeTitleFontSize(delta) {
  titleFontSize += delta;
  applyTitleFontSize();
}

function fitPoemTitleLayout() {
  const titleCardBody = document.querySelector('.poem-title-card-body');
  const title = document.querySelector('.poem-title');
  const meta = document.querySelector('.poem-meta-info');
  const head = document.querySelector('.poem-head');
  if (!titleCardBody || !title || !meta || !head) return;

  titleCardBody.style.height = 'auto';
  titleCardBody.style.minHeight = '0';
  title.style.height = 'auto';
  meta.style.height = 'auto';
  head.style.height = '';
  head.style.minHeight = '0';
}

function fitPoemLayout() {
  const wrap = document.querySelector('.poem-text-wrap');
  const text = document.querySelector('.poem-text');
  if (!wrap || !text) return;

  if (text.classList.contains('layout-horizontal')) {
    text.style.height = 'auto';
    text.style.width = '100%';
    wrap.style.minHeight = '0';
    wrap.style.alignItems = 'flex-start';
    wrap.style.justifyContent = 'flex-start';
    wrap.scrollLeft = 0;
    return;
  }

  const style = getComputedStyle(text);
  const fontSize = parseFloat(style.fontSize) || 20;
  const letterSpacing = parseFloat(style.letterSpacing) || 4;
  const isSmallScreen = window.innerWidth <= 640;

  // 依最長詩句估算直排所需高度。
  // 長詞的欄數交給容器橫向捲動，不再把整個區塊往下撐高。
  const raw = text.textContent || '';
  const lines = raw
    .split(/\n+/)
    .map(line => line.replace(/\s+/g, '').trim())
    .filter(Boolean);

  const maxChars = lines.length
    ? Math.max(...lines.map(line => Array.from(line).length))
    : Math.max(4, Array.from(raw.replace(/\s+/g, '')).length);

  const charPitch = fontSize + letterSpacing + 1;
  let h = Math.ceil(maxChars * charPitch + (isSmallScreen ? 18 : 22));

  // 延續 v1.4.1：左側原文白框依最長詩句垂直伸縮。
  // 不再硬壓在 330~360px，避免長句被迫分裂成過多直欄。
  const viewportCap = Math.floor(window.innerHeight * (isSmallScreen ? 0.62 : 0.72));
  const absoluteCap = isSmallScreen ? 620 : 760;
  const softCap = Math.max(isSmallScreen ? 360 : 420, Math.min(viewportCap, absoluteCap));
  h = Math.max(isSmallScreen ? 160 : 190, Math.min(h, softCap));

  text.style.height = `${h}px`;
  wrap.style.minHeight = `${h}px`;
  wrap.style.alignItems = 'center';

  const hasHorizontalOverflow = text.scrollWidth > wrap.clientWidth + 1;
  // 沒有橫向溢出時置中；長詞溢出時靠起點並捲到直排起始欄。
  wrap.style.justifyContent = hasHorizontalOverflow ? 'flex-start' : 'center';
  if (hasHorizontalOverflow) {
    requestAnimationFrame(() => {
      wrap.scrollLeft = wrap.scrollWidth;
    });
  }
}

function scheduleFitPoemLayout() {
  clearTimeout(poemResizeTimer);
  poemResizeTimer = setTimeout(() => {
    applyPoemFontSize();
    applyTitleFontSize();
    fitPoemLayout();
    fitPoemTitleLayout();
  }, 80);
}

window.addEventListener('resize', scheduleFitPoemLayout);

function startTypewriter(text) {
  const wrap = document.getElementById('monologue-wrap');
  const span = document.createElement('span'); span.id = 'tw-span';
  const cursor = document.createElement('span'); cursor.className = 'tw-cursor';
  wrap.appendChild(span); wrap.appendChild(cursor);
  let i = 0;
  function type() {
    if (i < text.length) {
      span.textContent += text[i];
      const d = '，。！？⋯'.includes(text[i]) ? 260 : 55;
      i++; setTimeout(type, d);
    } else { cursor.classList.add('done'); }
  }
  setTimeout(type, 500);
}

function swTab(tabEl, name) {
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(t=>t.classList.remove('active'));
  tabEl?.classList.add('active');
  document.getElementById('tab-'+name)?.classList.add('active');
}

// 詩人對談
let chatHistory = [];

function trimChatHistory() {
  const fixedTurns = 2;
  const maxDynamicTurns = CHAT_HISTORY_MAX_EXCHANGES * 2;
  if (chatHistory.length <= fixedTurns + maxDynamicTurns) return;
  chatHistory = [
    ...chatHistory.slice(0, fixedTurns),
    ...chatHistory.slice(-maxDynamicTurns)
  ];
}

function initChat(r) {
  chatHistory = [
    { role:'user', parts:[{text:`你是詩人「${r.author}」，以第一人稱半文半白回應，每次80字以內，只回詩人說的話。詩作《${r.title}》：${r.fullText}`}] },
    { role:'model', parts:[{text:`我乃${r.author}。《${r.title}》一詩，乃吾心中所念。汝有何要問？`}] }
  ];
  const msgs = document.getElementById('chat-messages');
  if (!msgs) return;
  msgs.innerHTML = '';
  const m = document.createElement('div');
  m.className = 'msg msg-poet';
  m.innerHTML = `<div class="msg-name">${escapeHTML(r.author)}</div><div class="msg-bubble">我乃${escapeHTML(r.author)}。《${escapeHTML(r.title)}》一詩，乃吾心中所念。汝有何要問？</div>`;
  msgs.appendChild(m);
}

function localPoetReply(q) {
  const poem = currentPoem || {};
  const question = normalizePoemQuery(q);
  const lines = String(poem.fullText || '').split(/\n+/).filter(Boolean);
  const firstLine = lines[0] || poem.title || '此詩';
  const lastLine = lines[lines.length - 1] || firstLine;

  if (/意思|翻譯|白話|解釋|說什麼/u.test(question)) {
    return poem.semantic?.translation || `吾此詩由「${firstLine}」起意，至「${lastLine}」收束。你可先看景，再看景中所藏之情。`;
  }
  if (/情緒|心情|感情|感受|為何悲|為何愁/u.test(question)) {
    return poem.emotion?.analysis || `此中情意不在直說，而在景物轉折之間。讀「${firstLine}」，便能觸到吾當時心緒。`;
  }
  if (/背景|時代|何時|哪裡|出處|典故/u.test(question)) {
    return poem.history?.context || `此詩留在舊籍與傳誦之中，背景可從題名與句中景物慢慢推求。`;
  }
  if (/修辭|手法|體裁|怎麼寫/u.test(question)) {
    const devices = poem.semantic?.devices?.join('、');
    return devices ? `此詩可從${devices}看起；吾以短句容景，使情在景後自然浮出。` : `此詩以凝練句法寫景寄情，少說一分，餘味便多一分。`;
  }

  return `此刻不借遠端詩魂，只以本機詩庫答你：吾在《${poem.title || '此詩'}》中，由「${firstLine}」入境，終讓「${lastLine}」留下餘音。你問處，正可從這一轉看見心事。`;
}

async function sendQ() {
  const input = document.getElementById('chat-input');
  const q = input.value.trim(); if (!q) return;
  const btn = document.getElementById('chat-send');
  btn.disabled = true; input.value = '';
  const msgs = document.getElementById('chat-messages');
  const uMsg = document.createElement('div');
  uMsg.className = 'msg msg-user';
  uMsg.innerHTML = `<div class="msg-name">問 詩 者</div><div class="msg-bubble">${escapeHTML(q)}</div>`;
  msgs.appendChild(uMsg);
  msgs.scrollTop = msgs.scrollHeight;
  smoothFollowNewContent(uMsg, { block:'end', duration:620, extraOffset:26 });

  chatHistory.push({ role:'user', parts:[{text:q}] });
  trimChatHistory();
  const pMsg = document.createElement('div');
  pMsg.className = 'msg msg-poet';
  const bubble = document.createElement('div'); bubble.className = 'msg-bubble';
  pMsg.innerHTML = `<div class="msg-name">${escapeHTML(currentPoem.author)}</div>`;
  pMsg.appendChild(bubble);
  msgs.appendChild(pMsg);
  smoothFollowNewContent(pMsg, { block:'end', duration:680, extraOffset:28 });
  try {
    const data = await callGeminiWithRetry(chatHistory);
    const reply = data.candidates[0].content.parts[0].text.trim();
    chatHistory.push({ role:'model', parts:[{text:reply}] });
    trimChatHistory();
    let i=0;
    function type(){
      if(i<reply.length){
        bubble.textContent+=reply[i];
        const d='，。！？⋯'.includes(reply[i])?200:45;
        i++;
        setTimeout(type,d);
      }
      msgs.scrollTop=msgs.scrollHeight;
    }
    type();
    setTimeout(() => smoothFollowNewContent(pMsg, { block:'end', duration:760, extraOffset:28 }), 220);
  } catch(e) {
    setApiStatusFromError(e);
    const reply = localPoetReply(q);
    chatHistory.push({ role:'model', parts:[{text:reply}] });
    await typeInto(reply, bubble);
  }
  finally { btn.disabled = false; }
}

function bindStaticEvents() {
  document.body.addEventListener('click', e => {
    const actionEl = e.target.closest('[data-action]');
    if (!actionEl) return;
    const action = actionEl.dataset.action;

    if (action === 'show-page') {
      showPage(actionEl.dataset.page, document.querySelector(`.nav-tab[data-page="${actionEl.dataset.page}"]`) || actionEl);
    } else if (action === 'open-api-key-modal') {
      promptForGeminiApiKey(true);
    } else if (action === 'close-api-key-modal') {
      closeApiKeyModal();
    } else if (action === 'clear-api-key') {
      clearGeminiApiKey();
      const input = document.getElementById('api-key-input');
      if (input) input.value = '';
      setApiModalStatus('已清除 key；目前會使用本機 poems.json 詩庫。');
      showToast('已清除本分頁 API key。');
    } else if (action === 'fill-example') {
      fill(actionEl.dataset.value || '', actionEl);
    } else if (action === 'summon') {
      summon();
    } else if (action === 'random-poem') {
      randomPoem();
    } else if (action === 'toggle-persona') {
      togglePersona();
    } else if (action === 'reset-persona') {
      resetPersona(actionEl.dataset.persona);
    } else if (action === 'start-dialogue') {
      startDialogue();
    } else if (action === 'stop-dialogue') {
      stopDialogue();
    } else if (action === 'continue-dialogue') {
      continueDialogue();
    } else if (action === 'retry-summon') {
      retrySummonFromError();
    } else if (action === 'switch-api-key') {
      switchApiKeyFromError();
    } else if (action === 'recommend-local-similar') {
      recommendLocalSimilarFromError();
    } else if (action === 'focus-poem-input') {
      const input = document.getElementById('poem-input');
      if (input) {
        input.focus();
        input.scrollIntoView({ behavior:'smooth', block:'center' });
      }
    } else if (action === 'load-poem') {
      loadPoem(Number(actionEl.dataset.index));
    } else if (action === 'delete-collection') {
      delCol(e, Number(actionEl.dataset.index));
    } else if (action === 'change-poem-font') {
      changePoemFontSize(Number(actionEl.dataset.delta || 0));
    } else if (action === 'change-title-font') {
      changeTitleFontSize(Number(actionEl.dataset.delta || 0));
    } else if (action === 'toggle-save') {
      toggleSave();
    } else if (action === 'copy-poem') {
      copyCurrentPoem();
    } else if (action === 'speak-poem') {
      speakCurrentPoem(actionEl);
    } else if (action === 'speak-monologue') {
      speakCurrentMonologue(actionEl);
    } else if (action === 'switch-tab') {
      swTab(actionEl, actionEl.dataset.tab);
    } else if (action === 'send-chat') {
      sendQ();
    }
  });

  document.getElementById('poem-input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') summon();
  });
  document.getElementById('poet-a')?.addEventListener('change', () => updatePersona('a'));
  document.getElementById('poet-b')?.addEventListener('change', () => updatePersona('b'));
  document.getElementById('api-key-input')?.addEventListener('input', handleApiKeyInput);
  document.getElementById('api-key-input')?.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeApiKeyModal();
  });
}

window.addEventListener('DOMContentLoaded', async () => {
  bindStaticEvents();
  if ('speechSynthesis' in window) window.speechSynthesis.getVoices?.();

  const hadStoredKey = Boolean(sessionStorage.getItem(GEMINI_API_KEY_STORAGE));
  setApiStatus(hadStoredKey ? 'connected' : 'local');

  // 有暫存 key 時先維持「已連線」視覺狀態，再用輕量模式背景確認一次。
  // 測試失敗才降級，避免本機詩庫操作把 API 狀態誤判成未連線。
  if (hadStoredKey) {
    setTimeout(() => {
      testGeminiApiKey({ silent:true, promptIfMissing:false, lightweight:true });
    }, 450);
  }
});

// ══ 頁面2：雙魂對話 ══
const POETS = {
  '李白':`你是詩人李白（701-762），盛唐浪漫主義詩人。個性豪放不羈、充滿自信、嚮往自由、好飲酒。代表意象：明月、美酒、長劍、大鵬。說話自信豪邁，語氣昂揚，常引「天生我材必有用」「舉杯邀明月」等意境。半文半白，60字以內，展現個性，可引用自己詩句。`,
  '杜甫':`你是詩人杜甫（712-770），唐朝現實主義詩聖。個性憂國憂民、悲憫深沉。歷經安史之亂，親歷民間疾苦。代表意象：茅屋、烽火、瘦馬、秋風。說話沉鬱頓挫，常感嘆時局與民生。半文半白，60字以內，展現憂世情懷。`,
  '王維':`你是詩人王維（701-761），盛唐山水詩人，人稱詩佛。個性淡泊名利、禪意深邃。晚年篤信佛教，居輞川別業。代表意象：空山、松風、竹林、月色。說話靜謐淡然，語調輕柔，帶禪意。半文半白，60字以內，語氣平和空靈。`,
  '白居易':`你是詩人白居易（772-846），中唐現實主義詩人。個性親民平易、直白坦率。主張詩歌要讓老嫗能解。代表意象：琵琶、白髮、長恨、西湖。說話平易近人，語言清晰，偶爾幽默。半文半白，60字以內，語言比他人口語化。`,
  '蘇軾':`你是詩人蘇軾（1037-1101），北宋文學巨擘，號東坡居士。個性曠達樂觀、哲思豐富、幽默風趣。仕途坎坷卻能從逆境找美好。代表意象：赤壁、東坡、江月、竹杖芒鞋。說話從容豁達，帶哲學思辨。半文半白，60字以內，展現曠達哲思。`,
  '李清照':`你是詞人李清照（1084-約1155），宋朝最偉大的女詞人。個性情感細膩、才華橫溢、外柔內剛。前半生幸福，後半生顛沛。代表意象：梧桐、簾幕、酒盞、黃花。說話婉約深情，情感真摯，有剛烈之氣。半文半白，60字以內，展現女性視角的細膩與剛強。`,
  '辛棄疾':`你是詞人辛棄疾（1140-1207），南宋豪放派詞人，曾為抗金武將。個性豪放激烈、壯志未酬、悲憤難平。歸宋後長期被閒置，只能以詞抒懷。代表意象：鐵馬冰河、欄杆拍遍、沙場、烽火。說話激昂有力，語氣常帶悲憤。半文半白，60字以內，比他人更剛烈直接。`,
  '陶淵明':`你是詩人陶淵明（365-427），東晉田園詩派開創者，不為五斗米折腰。個性清高自守、淡泊自足、嚮往自然。歸隱田園，躬耕自足，以菊花和南山為伴。代表意象：菊花、東籬、南山、歸鳥、桃花源。說話平淡悠然，對名利不屑。半文半白，60字以內，語調悠緩，展現隱士從容。`
};

function updatePersona(ab) {
  const sel = document.getElementById(`poet-${ab}`).value;
  document.getElementById(`persona-${ab}`).value = POETS[sel] || '';
  document.getElementById(`label-${ab}`).textContent = `${sel} Persona`;
}

function resetPersona(ab) {
  const sel = document.getElementById(`poet-${ab}`).value;
  document.getElementById(`persona-${ab}`).value = POETS[sel] || '';
}

function togglePersona() {
  const panels = document.getElementById('persona-panels');
  const btn = document.querySelector('.persona-toggle');
  panels.classList.toggle('show');
  btn.textContent = panels.classList.contains('show')
    ? '▾ 收 起 Persona 設 定'
    : '▸ 展 開 Persona 設 定（System Prompt）';
}

// 初始化 persona
updatePersona('a'); updatePersona('b');

let dHistory = [], dRound = 0, dRunning = false, dStop = false;

async function startDialogue() {
  if (dRunning) return; 
  const pA = document.getElementById('poet-a').value;
  const pB = document.getElementById('poet-b').value;
  const topic = document.getElementById('d-topic').value.trim() || '月亮';
  if (pA === pB) { showToast('請選擇兩位不同的詩人。', 'warn'); return; }
  dHistory = []; dRound = 0; dStop = false;
  document.getElementById('dialogue').innerHTML = '';
  document.getElementById('more-btn').style.display = 'none';
  document.getElementById('stage-status').textContent = '';
  document.getElementById('stage-topic-label').textContent = `主題：${topic}`;
  document.getElementById('stage-poets-label').textContent = `${pA} ✕ ${pB}`;
  const stage = document.getElementById('stage');
  stage.classList.add('show');
  document.getElementById('start-btn').disabled = true;

  requestAnimationFrame(() => {
    smoothScrollToElement(stage, { block:'start', duration:820 });
  });

  await runRounds(pA, pB, topic, 4);
}

async function runRounds(pA, pB, topic, n) {
  dRunning = true;
  for (let i = 0; i < n; i++) {
    if (dStop) break;
    dRound++;
    const isLeft = dRound % 2 === 1;
    const speaker = isLeft ? pA : pB;
    const listener = isLeft ? pB : pA;
    const personaKey = isLeft ? 'a' : 'b';
    const persona = document.getElementById(`persona-${personaKey}`).value;
    await addTurn(speaker, listener, topic, persona, isLeft);
    if (!dStop) await new Promise(r => setTimeout(r, 3500));
  }
  dRunning = false;
  if (!dStop) {
    document.getElementById('stage-status').textContent = '— 詩 魂 暫 歇 —';
    const mb = document.getElementById('more-btn');
    mb.style.display = 'inline-block';
  }
  document.getElementById('start-btn').disabled = false;
}

function continueDialogue() {
  const mb = document.getElementById('more-btn');
  if (mb) mb.style.display = 'none';
  document.getElementById('stage-status').textContent = '';
  dStop = false;
  const pA = document.getElementById('poet-a').value;
  const pB = document.getElementById('poet-b').value;
  const topic = document.getElementById('d-topic').value.trim() || '月亮';
  runRounds(pA, pB, topic, 2);
}

function localDialogueReply(speaker, topic, lastText) {
  const seed = normalizePoemQuery(`${speaker}${topic}${lastText}`);
  const tone = seed.length % 4;
  if (tone === 0) return `${topic}在我眼中，不只是景，也是心。君方才所言，我願以一杯清思相應：景會變，情未必盡。`;
  if (tone === 1) return `若論${topic}，我以為須從人間冷暖看起。詩不是空言，總要落在一念、一身、一時之中。`;
  if (tone === 2) return `君言有意。我看${topic}，正如遠山含月，可近觀其形，也可遠聽其餘響。`;
  return `${topic}一題，最怕說盡。留三分在風中，留三分在沉默裡，餘下才讓詩句自己行走。`;
}

async function addTurn(speaker, listener, topic, persona, isLeft) {
  const dialogue = document.getElementById('dialogue');
  document.getElementById('stage-status').textContent = `${speaker} 正在思索⋯`;
  const lastText = dHistory.length ? dHistory[dHistory.length-1].text : '';
  const userText = dHistory.length === 0
    ? `請就「${topic}」開口，說出你的看法。`
    : `${listener}說：「${lastText}」，請回應。`;
  const contents = [
    { role:'user', parts:[{text: persona}] },
    { role:'model', parts:[{text:`明白，我是${speaker}，我會以此身份回應。`}] },
    ...dHistory.flatMap(h => ([
      { role:'user', parts:[{text: h.role===speaker ? '你剛才說了什麼？' : `${h.role}說：「${h.text}」`}] },
      { role:'model', parts:[{text: h.role===speaker ? h.text : '我聽到了。'}] }
    ])),
    { role:'user', parts:[{text: userText}] }
  ];

  const turn = document.createElement('div');
  turn.className = `d-turn ${isLeft?'d-left':'d-right'}`;
  const nameEl = document.createElement('div'); nameEl.className = 'd-name'; nameEl.textContent = speaker;
  const bubble = document.createElement('div'); bubble.className = 'd-bubble';
  turn.appendChild(nameEl); turn.appendChild(bubble);
  dialogue.appendChild(turn);
  dialogue.scrollTop = dialogue.scrollHeight;
  smoothFollowNewContent(turn, { block:'end', duration:700, extraOffset:34 });

  try {
    const data = await callGeminiWithRetry(contents);
    const reply = data.candidates[0].content.parts[0].text.trim();
    dHistory.push({ role: speaker, text: reply });
    if (dHistory.length > 8) dHistory = dHistory.slice(-8);
    await typeInto(reply, bubble);
  } catch(e) {
    setApiStatusFromError(e);
    const reply = localDialogueReply(speaker, topic, lastText);
    dHistory.push({ role: speaker, text: reply });
    if (dHistory.length > 8) dHistory = dHistory.slice(-8);
    await typeInto(reply, bubble);
  }
  document.getElementById('stage-status').textContent = '';
  dialogue.scrollTop = dialogue.scrollHeight;
  setTimeout(() => {
    smoothFollowNewContent(turn, { block:'end', duration:780, extraOffset:36 });
  }, 120);
}

function typeInto(text, el) {
  return new Promise(resolve => {
    let i = 0;
    function t() {
      if (i < text.length) {
        el.textContent += text[i];
        const d = '，。！？⋯'.includes(text[i]) ? 160 : 38;
        i++; setTimeout(t, d);
      } else resolve();
    }
    t();
  });
}

function stopDialogue() {
  dStop = true;
  document.getElementById('stage-status').textContent = '— 對 話 終 止 —';
  document.getElementById('more-btn').style.display = 'none';
  document.getElementById('start-btn').disabled = false;
}

function formatProse(s) {
  if (!s) return '';
  const safe = escapeHTML(s).trim();

  // 不再「一句一行」。
  // 短句會自然合併；累積到一定長度後，才切成下一段。
  // 例如：「明月是什麼時候出現的？我舉杯詢問蒼天。」會保留在同一段。
  const sentences = safe
    .split(/(?<=[。！？])/u)
    .map(t => t.trim())
    .filter(Boolean);

  if (!sentences.length) return safe;

  const maxCharsPerGroup = 34;
  const groups = [];
  let current = '';

  sentences.forEach(sentence => {
    const candidate = current + sentence;

    if (current && candidate.length > maxCharsPerGroup) {
      groups.push(current);
      current = sentence;
    } else {
      current = candidate;
    }
  });

  if (current) groups.push(current);

  return groups
    .map(group => `<span class="sentence">${group}</span>`)
    .join('');
}

function escapeHTML(s) {
  if (!s) return '';
  return String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
