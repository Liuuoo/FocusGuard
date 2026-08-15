const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");
const {
  APP_CLASSIFICATION_POLICY_VERSION,
  classifyAppWithAI,
  classifyKnownApp,
  heuristicClassifyApp,
  isEntertainmentClassification
} = require("./app-classifier");
const {
  getDaySchedule,
  normalizeSchoolBreaks,
  validateSchoolBreaks
} = require("./schedule");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const PUBLIC_DIR = path.join(ROOT, "public");
const DB_PATH = path.join(DATA_DIR, "focusguard.json");
const BROWSER_EXTENSION_DIR = path.join(DATA_DIR, "browser-extension");
const BROWSER_EXTENSION_METADATA_PATH = path.join(BROWSER_EXTENSION_DIR, "metadata.json");
const PORT = Number(process.env.FOCUSGUARD_PORT || 37831);
const DEEPSEEK_API_URL = "https://api.deepseek.com/chat/completions";
const DEFAULT_AI_MODEL = "deepseek-v4-pro";
const ADMIN_SUMMARY_MINUTES = 3;
const ADMIN_SUMMARY_MIN_MS = ADMIN_SUMMARY_MINUTES * 60 * 1000;
const MANUAL_APP_CATEGORIES = new Set([
  "entertainment",
  "work",
  "study",
  "shopping",
  "social",
  "news",
  "tool",
  "unknown"
]);

fs.mkdirSync(DATA_DIR, { recursive: true });

const defaultDb = {
  config: {
    passwordHash: "",
    passwordSalt: "",
    appWhitelist: ["explorer.exe", "lockapp.exe", "searchhost.exe"],
    runningAppWhitelist: [
      "aggregatorhost.exe",
      "appactions.exe",
      "applicationframehost.exe",
      "backgroundtaskhost.exe",
      "chsime.exe",
      "conhost.exe",
      "crashpad_handler.exe",
      "crossdeviceresume.exe",
      "crossdeviceservice.exe",
      "csrss.exe",
      "ctfmon.exe",
      "dwm.exe",
      "elevation_service.exe",
      "fontdrvhost.exe",
      "idle.exe",
      "lsaiso.exe",
      "lsass.exe",
      "memory compression.exe",
      "microsoftstartfeedprovider.exe",
      "mousocoreworker.exe",
      "mpdefendercoreservice.exe",
      "msedgewebview2.exe",
      "msmpeng.exe",
      "mspcmanagerservice.exe",
      "nissrv.exe",
      "node.exe",
      "node_repl.exe",
      "nvdisplay.container.exe",
      "powershell.exe",
      "registry.exe",
      "runtimebroker.exe",
      "searchfilterhost.exe",
      "searchindexer.exe",
      "searchprotocolhost.exe",
      "secure system.exe",
      "securityhealthservice.exe",
      "securityhealthsystray.exe",
      "service.exe",
      "services.exe",
      "shellexperiencehost.exe",
      "shellhost.exe",
      "sihost.exe",
      "smartscreen.exe",
      "smss.exe",
      "spoolsv.exe",
      "startmenuexperiencehost.exe",
      "svchost.exe",
      "system.exe",
      "systemsettings.exe",
      "taskhostw.exe",
      "textinputhost.exe",
      "useroobebroker.exe",
      "vmcompute.exe",
      "widgetboard.exe",
      "widgetservice.exe",
      "wininit.exe",
      "winlogon.exe",
      "wmiprvse.exe",
      "wslservice.exe",
      "wudfhost.exe"
    ],
    browserApps: ["chrome.exe", "msedge.exe", "firefox.exe", "brave.exe", "opera.exe"],
    blockedBrowserExes: [
      "chrome.exe",
      "firefox.exe",
      "360se.exe",
      "360chrome.exe",
      "360browser.exe",
      "2345explorer.exe",
      "2345chrome.exe",
      "2345browser.exe",
      "quark.exe",
      "quarkbrowser.exe",
      "opera.exe",
      "operagx.exe",
      "brave.exe",
      "vivaldi.exe",
      "sogouexplorer.exe",
      "qqbrowser.exe",
      "ucbrowser.exe",
      "maxthon.exe",
      "torbrowser.exe",
      "yandex.exe",
      "librewolf.exe",
      "waterfox.exe",
      "baidubrowser.exe",
      "liebao.exe"
    ],
    browserTitleWhitelist: [],
    appClassificationOverrides: {},
    aiClassification: {
      enabled: true,
      model: DEFAULT_AI_MODEL
    },
    entertainmentLimits: {
      weekdayMinutes: 60,
      weekendMinutes: 120
    },
    schoolBreaks: {
      winterStart: "",
      winterEnd: "",
      summerStart: "",
      summerEnd: ""
    },
    browserEntertainmentLimits: {
      weekdayMinutes: 60,
      weekendMinutes: 120
    },
    monitorIntervalMs: 1000
  },
  totals: {},
  runningTotals: {},
  browserTotals: {},
  classificationCache: {},
  appClassificationCache: {},
  sessions: [],
  limitEvents: [],
  lastLimitError: null,
  lastSeen: null,
  lastProcesses: []
};

let db = loadDb();
let current = null;
let foregroundMonitor = null;
let foregroundBuffer = "";
let processMonitor = null;
let processBuffer = "";
let browserDownloadGuard = null;
let lastProcessSample = null;
let lastWindowSample = null;
const lastLimitActions = new Map();
const lastBrowserBlockActions = new Map();
const appClassifyInFlight = new Set();
const browserFallbackClassifyInFlight = new Set();
const tokens = new Map();
const browserExtensionHints = new Map();
const visibleBrowserSessions = new Map();
const visibleAppSessions = new Map();
const lastNativeBrowserCloseActions = new Map();
const nativeBrowserLimitFirstSeen = new Map();
let lastBrowserExtensionSeenAt = 0;
let nativeBrowserWindowTracking = false;
let lastNativeBrowserWindowSampleAt = 0;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function loadDb() {
  if (!fs.existsSync(DB_PATH)) return clone(defaultDb);
  try {
    const stored = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
    const mergedConfig = { ...clone(defaultDb).config, ...(stored.config || {}) };
    const storedEntertainmentLimits = stored.config?.entertainmentLimits
      || stored.config?.browserEntertainmentLimits
      || defaultDb.config.entertainmentLimits;
    mergedConfig.entertainmentLimits = normalizeEntertainmentLimits(storedEntertainmentLimits);
    mergedConfig.browserEntertainmentLimits = clone(mergedConfig.entertainmentLimits);
    mergedConfig.schoolBreaks = normalizeSchoolBreaks(
      stored.config?.schoolBreaks || defaultDb.config.schoolBreaks
    );
    mergedConfig.appClassificationOverrides = normalizeAppClassificationOverrides(
      stored.config?.appClassificationOverrides
    );
    mergedConfig.aiClassification = {
      ...clone(defaultDb).config.aiClassification,
      ...(stored.config?.aiClassification || {})
    };
    if (!mergedConfig.aiClassification.model
      || normalizePattern(mergedConfig.aiClassification.model) === "deepseek-v4-flash") {
      mergedConfig.aiClassification.model = DEFAULT_AI_MODEL;
    }
    delete mergedConfig.appLimits;
    mergedConfig.runningAppWhitelist = Array.from(new Set([
      ...clone(defaultDb).config.runningAppWhitelist,
      ...(stored.config?.runningAppWhitelist || [])
    ].map(normalizeExe).filter(Boolean)));
    return {
      ...clone(defaultDb),
      ...stored,
      config: mergedConfig
    };
  } catch {
    return clone(defaultDb);
  }
}

function saveDb() {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function deepSeekApiKey() {
  return process.env.DEEPSEEK_API_KEY || "";
}

function todayKey(ms = Date.now()) {
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function normalizeExe(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizePattern(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeManualAppCategory(value) {
  const category = normalizePattern(value);
  return MANUAL_APP_CATEGORIES.has(category) ? category : "";
}

function normalizeAppClassificationOverrides(value) {
  const overrides = {};
  if (!value || typeof value !== "object") return overrides;

  for (const [rawExe, rawEntry] of Object.entries(value)) {
    const exe = normalizeExe(rawExe);
    const category = normalizeManualAppCategory(rawEntry?.category || rawEntry);
    if (!exe || !category || category === "unknown") continue;
    overrides[exe] = {
      category,
      updatedAt: Number(rawEntry?.updatedAt || Date.now())
    };
  }
  return overrides;
}

function normalizeUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (!["http:", "https:"].includes(url.protocol)) return null;
    return url;
  } catch {
    return null;
  }
}

function searchQueryFromUrl(url) {
  const searchHosts = new Set([
    "www.bing.com",
    "bing.com",
    "www.google.com",
    "google.com",
    "www.baidu.com",
    "baidu.com",
    "www.so.com",
    "so.com",
    "www.sogou.com",
    "sogou.com"
  ]);
  if (!searchHosts.has(url.hostname.toLowerCase())) return "";
  for (const key of ["q", "wd", "query", "keyword"]) {
    const value = url.searchParams.get(key);
    if (value) return value.trim();
  }
  return "";
}

function normalizeDayType(value) {
  const dayType = String(value || "").trim().toLowerCase();
  if (["weekday", "workday", "工作日"].includes(dayType)) return "weekday";
  if (["weekend", "holiday", "nonworkday", "非工作日", "休息日", "周末"].includes(dayType)) return "weekend";
  return "all";
}

function normalizeEntertainmentLimits(value = {}) {
  return {
    weekdayMinutes: Math.max(0, Number(value.weekdayMinutes || 0)),
    weekendMinutes: Math.max(0, Number(value.weekendMinutes || 0))
  };
}

function isEntertainmentCategory(category) {
  return ["entertainment", "social"].includes(normalizePattern(category));
}

function currentDayType(ms = Date.now()) {
  return getDaySchedule(ms, db.config.schoolBreaks).dayType;
}

function currentDaySchedule(ms = Date.now()) {
  return getDaySchedule(ms, db.config.schoolBreaks);
}

function exeFromActivity(activity) {
  return normalizeExe(activity.exe || `${activity.processName || "unknown"}.exe`) || "unknown.exe";
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.pbkdf2Sync(String(password), salt, 210000, 32, "sha256").toString("hex");
  return { salt, hash };
}

function verifyPassword(password) {
  if (!db.config.passwordHash || !db.config.passwordSalt) return true;
  const { hash } = hashPassword(password, db.config.passwordSalt);
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(db.config.passwordHash));
}

function isAppWhitelisted(exe) {
  return db.config.appWhitelist.map(normalizeExe).includes(normalizeExe(exe));
}

function isRunningWhitelisted(exe) {
  const cleanExe = normalizeExe(exe);
  return isAppWhitelisted(cleanExe) || db.config.runningAppWhitelist.map(normalizeExe).includes(cleanExe);
}

function isBrowserExe(exe) {
  const cleanExe = normalizeExe(exe);
  return db.config.browserApps.map(normalizeExe).includes(cleanExe);
}

function nativeWindowTrackingActive(now = Date.now()) {
  return lastWindowSample
    && lastWindowSample.timestamp > 0
    && now - lastWindowSample.timestamp <= 5000;
}

function nativeBrowserTrackingActive(now = Date.now()) {
  return nativeBrowserWindowTracking
    && lastNativeBrowserWindowSampleAt > 0
    && now - lastNativeBrowserWindowSampleAt <= 5000;
}

function manualAppClassification(exe) {
  const entry = db.config.appClassificationOverrides?.[normalizeExe(exe)];
  const category = normalizeManualAppCategory(entry?.category);
  if (!category || category === "unknown") return null;
  return {
    category,
    isEntertainment: isEntertainmentCategory(category),
    confidence: 1,
    needsResearch: false,
    researchQuery: "",
    reason: "管理员手动分组",
    evidence: [],
    manual: true
  };
}

function appClassificationCacheValid(cached, now = Date.now()) {
  if (!cached || cached.policyVersion !== APP_CLASSIFICATION_POLICY_VERSION) return false;
  const ttl = cached.result?.needsResearch ? 15 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
  return now - Number(cached.timestamp || 0) < ttl;
}

function saveAppClassification(exe, result, now = Date.now()) {
  const cleanExe = normalizeExe(exe);
  if (!cleanExe || !result) return;
  const previous = db.appClassificationCache?.[cleanExe];
  const next = {
    timestamp: now,
    policyVersion: APP_CLASSIFICATION_POLICY_VERSION,
    result
  };
  if (JSON.stringify(previous) === JSON.stringify(next)) return;
  db.appClassificationCache[cleanExe] = next;
  saveDb();
}

function getAppClassification(activity) {
  const exe = exeFromActivity(activity);
  if (isBrowserExe(exe)) return { category: "tool", confidence: 1, reason: "浏览器由标签页分类" };
  const manual = manualAppClassification(exe);
  if (manual) return manual;
  const known = classifyKnownApp(activity);
  if (known) return known;
  const cached = db.appClassificationCache?.[exe];
  if (appClassificationCacheValid(cached)) {
    return cached.result;
  }
  return heuristicClassifyApp(activity);
}

async function aiClassifyApp(activity) {
  const key = deepSeekApiKey();
  const model = db.config.aiClassification?.model || DEFAULT_AI_MODEL;
  if (!key || !db.config.aiClassification?.enabled) return heuristicClassifyApp(activity);
  return classifyAppWithAI(activity, { apiKey: key, model });
}

function ensureAppClassification(activity) {
  const exe = exeFromActivity(activity);
  if (isBrowserExe(exe) || isAppWhitelisted(exe)) return;
  if (manualAppClassification(exe)) return;
  const known = classifyKnownApp(activity);
  if (known) {
    saveAppClassification(exe, known);
    return;
  }
  if (!deepSeekApiKey() || !db.config.aiClassification?.enabled) return;
  const cached = db.appClassificationCache?.[exe];
  if (appClassificationCacheValid(cached)) return;
  if (appClassifyInFlight.has(exe)) return;

  appClassifyInFlight.add(exe);
  aiClassifyApp(activity)
    .then((result) => {
      saveAppClassification(exe, result);
    })
    .catch(() => {})
    .finally(() => appClassifyInFlight.delete(exe));
}

function browserFallbackKey(activity) {
  return `browser-title:${normalizePattern(activity.title).slice(0, 200) || "empty"}`;
}

function browserFallbackUrl() {
  return new URL("https://browser.local/");
}

function getBrowserFallbackClassification(activity) {
  const title = String(activity.title || "").trim();
  const cached = db.classificationCache?.[browserFallbackKey(activity)];
  const result = cached?.result || heuristicClassify(browserFallbackUrl(), title);
  return {
    ...result,
    hostname: "浏览器标签页",
    url: "",
    title
  };
}

function ensureBrowserFallbackClassification(activity) {
  const exe = exeFromActivity(activity);
  if (!isBrowserExe(exe) || isActiveWhitelisted(activity)) return;
  if (Date.now() - lastBrowserExtensionSeenAt < 90 * 1000) return;
  if (!deepSeekApiKey() || !db.config.aiClassification?.enabled) return;

  const key = browserFallbackKey(activity);
  const cached = db.classificationCache?.[key];
  if (cached && Date.now() - Number(cached.timestamp || 0) < 7 * 24 * 60 * 60 * 1000) return;
  if (browserFallbackClassifyInFlight.has(key)) return;

  browserFallbackClassifyInFlight.add(key);
  aiClassifyPage(browserFallbackUrl(), String(activity.title || ""))
    .then((result) => {
      db.classificationCache[key] = { timestamp: Date.now(), result };
      saveDb();
    })
    .catch(() => {})
    .finally(() => browserFallbackClassifyInFlight.delete(key));
}

function shouldUseBrowserFallback(session) {
  return Boolean(session
    && isBrowserExe(exeFromActivity(session.activity))
    && !nativeBrowserTrackingActive()
    && !isActiveWhitelisted(session.activity)
    && !session.browserExtensionReportedAt);
}

function isActiveWhitelisted(activity) {
  const exe = exeFromActivity(activity);
  if (isAppWhitelisted(exe)) return true;

  const browserApps = db.config.browserApps.map(normalizeExe);
  if (browserApps.includes(exe)) {
    const title = normalizePattern(activity.title);
    return db.config.browserTitleWhitelist
      .map(normalizePattern)
      .filter(Boolean)
      .some((pattern) => title.includes(pattern));
  }

  return false;
}

function normalizeWindowRect(value) {
  if (!value || typeof value !== "object") return null;
  const left = Number(value.left);
  const top = Number(value.top);
  let right = Number(value.right);
  let bottom = Number(value.bottom);
  if (!Number.isFinite(right) && Number.isFinite(value.width)) right = left + Number(value.width);
  if (!Number.isFinite(bottom) && Number.isFinite(value.height)) bottom = top + Number(value.height);
  if (![left, top, right, bottom].every(Number.isFinite) || right <= left || bottom <= top) return null;
  return { left, top, right, bottom };
}

function rectIntersectionArea(a, b) {
  if (!a || !b) return 0;
  const width = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
  const height = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  return width * height;
}

function mergeIntervals(intervals) {
  const sorted = intervals
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (!last || interval[0] > last[1]) merged.push(interval.slice());
    else last[1] = Math.max(last[1], interval[1]);
  }
  return merged;
}

function visibleWindowRatio(target, windows) {
  if (!target || target.minimized || target.visible === false || target.windowState === "minimized") return 0;
  const rect = normalizeWindowRect(target);
  if (!rect) return 0;
  const targetArea = (rect.right - rect.left) * (rect.bottom - rect.top);
  if (targetArea < 320 * 180) return 0;

  const blockers = windows
    .filter((window) => String(window.hwnd || "") !== String(target.hwnd || ""))
    .filter((window) => window.visible !== false && !window.minimized && window.windowState !== "minimized")
    .filter((window) => Number(window.zIndex) < Number(target.zIndex))
    .map((window) => normalizeWindowRect(window))
    .filter((rectValue) => rectIntersectionArea(rect, rectValue) > 0);

  if (!blockers.length) return 1;

  const xCoordinates = new Set([rect.left, rect.right]);
  for (const blocker of blockers) {
    xCoordinates.add(Math.max(rect.left, blocker.left));
    xCoordinates.add(Math.min(rect.right, blocker.right));
  }
  const sortedX = Array.from(xCoordinates).sort((a, b) => a - b);
  let visibleArea = 0;

  for (let index = 0; index < sortedX.length - 1; index += 1) {
    const x1 = sortedX[index];
    const x2 = sortedX[index + 1];
    if (x2 <= x1) continue;
    const coveredY = mergeIntervals(blockers
      .filter((blocker) => blocker.left < x2 && blocker.right > x1)
      .map((blocker) => [Math.max(rect.top, blocker.top), Math.min(rect.bottom, blocker.bottom)]));
    const coveredHeight = coveredY.reduce((sum, [start, end]) => sum + Math.max(0, end - start), 0);
    visibleArea += (x2 - x1) * Math.max(0, rect.bottom - rect.top - coveredHeight);
  }

  const ratio = visibleArea / targetArea;
  return ratio < 0.2 || visibleArea < 320 * 180 ? 0 : Math.min(1, Math.max(0, ratio));
}

function browserHintBounds(hint) {
  return normalizeWindowRect(hint?.windowBounds || hint?.bounds);
}

function browserHintScore(window, hint, now = Date.now()) {
  const age = now - Number(hint.seenAt || 0);
  if (age > 2 * 60 * 1000) return -Infinity;

  const nativeTitle = normalizePattern(window.title);
  const hintTitle = normalizePattern(hint.title);
  const nativeBounds = normalizeWindowRect(window);
  const extensionBounds = browserHintBounds(hint);
  let score = Math.max(0, 120 - age / 1000);
  let matched = false;

  if (nativeTitle && hintTitle) {
    if (nativeTitle === hintTitle) {
      score += 1400;
      matched = true;
    } else if (nativeTitle.includes(hintTitle) || hintTitle.includes(nativeTitle)) {
      score += 700;
      matched = true;
    }
  }

  if (nativeBounds && extensionBounds) {
    const nativeArea = (nativeBounds.right - nativeBounds.left) * (nativeBounds.bottom - nativeBounds.top);
    const extensionArea = (extensionBounds.right - extensionBounds.left) * (extensionBounds.bottom - extensionBounds.top);
    const intersection = rectIntersectionArea(nativeBounds, extensionBounds);
    const union = nativeArea + extensionArea - intersection;
    if (intersection > 0 && union > 0) {
      score += (intersection / union) * 900;
      matched = true;
    }
  }

  return matched ? score : -Infinity;
}

function pruneBrowserExtensionHints(now = Date.now()) {
  for (const [key, hint] of browserExtensionHints) {
    if (now - Number(hint.seenAt || 0) > 3 * 60 * 1000) browserExtensionHints.delete(key);
  }
}

function findBrowserExtensionHint(window, usedHintKeys, now = Date.now()) {
  let best = null;
  let bestScore = -Infinity;
  for (const [key, hint] of browserExtensionHints) {
    if (usedHintKeys.has(key)) continue;
    const score = browserHintScore(window, hint, now);
    if (score > bestScore) {
      best = { key, hint };
      bestScore = score;
    }
  }
  if (!best) return null;
  usedHintKeys.add(best.key);
  return best.hint;
}

function browserWindowActivity(window, usedHintKeys, now = Date.now()) {
  const hint = findBrowserExtensionHint(window, usedHintKeys, now);
  const activity = {
    ...window,
    exe: normalizeExe(window.exe || `${window.processName || "unknown"}.exe`),
    title: String(hint?.title || window.title || "").trim(),
    browserUrl: String(hint?.url || ""),
    browserWindowId: hint?.windowId ?? null,
    browserExtensionReportedAt: Number(hint?.seenAt || 0)
  };
  activity.browserClassification = hint?.classification || getBrowserFallbackClassification(activity);
  return activity;
}

function browserWindowKey(window) {
  if (window.hwnd) return `hwnd:${window.hwnd}`;
  const rect = normalizeWindowRect(window);
  return `window:${window.pid || 0}:${rect ? `${rect.left},${rect.top},${rect.right},${rect.bottom}` : "unknown"}`;
}

function browserWindowSignature(activity) {
  return [
    activity.pid || 0,
    exeFromActivity(activity),
    activity.title || "",
    activity.browserUrl || "",
    activity.browserClassification?.category || "unknown"
  ].join("|");
}

function appWindowSignature(activity) {
  return [
    activity.pid || 0,
    exeFromActivity(activity),
    activity.title || ""
  ].join("|");
}

function recordSession(activity, startedAt, endedAt, durationMs) {
  if (!activity || isActiveWhitelisted(activity) || durationMs < 1000) return;
  db.sessions.push({
    startedAt,
    endedAt,
    durationMs,
    exe: activity.exe,
    processName: activity.processName,
    title: activity.title
  });
  if (db.sessions.length > 2000) db.sessions = db.sessions.slice(-2000);
}

function settleVisibleBrowserSession(session, endMs = Date.now()) {
  if (!session) return;
  const rawDurationMs = Math.min(5000, Math.max(0, endMs - session.lastSampleAt));
  const visibleRatio = Math.min(1, Math.max(0, Number(session.visibleRatio || 0)));
  const durationMs = rawDurationMs * visibleRatio;
  if (durationMs <= 0) return;

  const activity = session.activity;
  addActiveDuration(activity, durationMs, endMs);
  const classification = activity.browserClassification || getBrowserFallbackClassification(activity);
  if (!isActiveWhitelisted(activity) && classification.category !== "whitelist") {
    addBrowserDuration(classification, durationMs, endMs);
  }
  recordSession(activity, session.lastSampleAt, endMs, durationMs);
}

function ingestVisibleBrowserWindows(rawWindows, now = Date.now()) {
  nativeBrowserWindowTracking = true;
  lastNativeBrowserWindowSampleAt = now;
  pruneBrowserExtensionHints(now);

  const windows = (Array.isArray(rawWindows) ? rawWindows : [])
    .map((window, index) => ({
      ...window,
      zIndex: Number.isFinite(Number(window.zIndex)) ? Number(window.zIndex) : index
    }))
    .filter((window) => normalizeWindowRect(window));
  const usedHintKeys = new Set();
  const next = new Map();

  for (const window of windows) {
    if (!isBrowserExe(window.exe || `${window.processName || ""}.exe`)) continue;
    const activity = browserWindowActivity(window, usedHintKeys, now);
    ensureBrowserFallbackClassification(activity);
    const key = browserWindowKey(window);
    next.set(key, {
      key,
      signature: browserWindowSignature(activity),
      activity,
      visibleRatio: visibleWindowRatio(window, windows),
      lastSampleAt: now
    });
  }

  for (const [key, session] of visibleBrowserSessions) {
    const candidate = next.get(key);
    if (!candidate) {
      settleVisibleBrowserSession(session, now);
      visibleBrowserSessions.delete(key);
      continue;
    }

    if (candidate.signature !== session.signature) {
      settleVisibleBrowserSession(session, now);
      visibleBrowserSessions.delete(key);
      continue;
    }

    settleVisibleBrowserSession(session, now);
    session.activity = candidate.activity;
    session.visibleRatio = candidate.visibleRatio;
    session.lastSampleAt = now;
    next.delete(key);
  }

  for (const [key, session] of next) visibleBrowserSessions.set(key, session);
  enforceNativeBrowserEntertainmentLimit(now);
  saveDb();
}

function flushVisibleBrowserSessions(endMs = Date.now()) {
  for (const session of visibleBrowserSessions.values()) settleVisibleBrowserSession(session, endMs);
  visibleBrowserSessions.clear();
}

function settleVisibleAppSession(session, endMs = Date.now()) {
  if (!session) return;
  const rawDurationMs = Math.min(5000, Math.max(0, endMs - session.lastSampleAt));
  const visibleRatio = Math.min(1, Math.max(0, Number(session.visibleRatio || 0)));
  const durationMs = rawDurationMs * visibleRatio;
  if (durationMs <= 0) return;

  const activity = session.activity;
  addActiveDuration(activity, durationMs, endMs);
  recordSession(activity, session.lastSampleAt, endMs, durationMs);
}

function ingestVisibleAppWindows(rawWindows, now = Date.now()) {
  const windows = (Array.isArray(rawWindows) ? rawWindows : [])
    .map((window, index) => ({
      ...window,
      zIndex: Number.isFinite(Number(window.zIndex)) ? Number(window.zIndex) : index
    }))
    .filter((window) => normalizeWindowRect(window));
  const next = new Map();

  for (const window of windows) {
    const exe = normalizeExe(window.exe || `${window.processName || "unknown"}.exe`);
    const title = String(window.title || "").trim();
    if (isBrowserExe(exe) || !title) continue;
    // System processes are still sampled by foreground.ps1, but they are not
    // user-facing usage sessions. Explicit app whitelist entries remain
    // visible so the live panel can explain why they are excluded.
    if (isRunningWhitelisted(exe) && !isAppWhitelisted(exe)) continue;

    const activity = {
      ...window,
      exe,
      title
    };
    ensureAppClassification(activity);
    const key = browserWindowKey(window);
    next.set(key, {
      key,
      signature: appWindowSignature(activity),
      activity,
      visibleRatio: visibleWindowRatio(window, windows),
      lastSampleAt: now
    });
  }

  for (const [key, session] of visibleAppSessions) {
    const candidate = next.get(key);
    if (!candidate) {
      settleVisibleAppSession(session, now);
      visibleAppSessions.delete(key);
      continue;
    }

    if (candidate.signature !== session.signature) {
      settleVisibleAppSession(session, now);
      visibleAppSessions.delete(key);
      continue;
    }

    settleVisibleAppSession(session, now);
    session.activity = candidate.activity;
    session.visibleRatio = candidate.visibleRatio;
    session.lastSampleAt = now;
    next.delete(key);
  }

  for (const [key, session] of next) visibleAppSessions.set(key, session);
}

function flushVisibleAppSessions(endMs = Date.now()) {
  for (const session of visibleAppSessions.values()) settleVisibleAppSession(session, endMs);
  visibleAppSessions.clear();
}

function visibleBrowserWindowCount() {
  return Array.from(visibleBrowserSessions.values())
    .filter((session) => Number(session.visibleRatio || 0) > 0)
    .length;
}

function activityKey(activity) {
  return `${exeFromActivity(activity)}|${String(activity.title || "").slice(0, 160)}`;
}

function addActiveDuration(activity, durationMs, endMs) {
  if (!activity || durationMs <= 0 || isActiveWhitelisted(activity)) return;
  const day = todayKey(endMs);
  const exe = exeFromActivity(activity);
  db.totals[day] ||= {};
  db.totals[day][exe] ||= { ms: 0, titles: {} };
  db.totals[day][exe].ms += durationMs;

  const title = String(activity.title || "").trim();
  if (title) {
    db.totals[day][exe].titles[title] ||= 0;
    db.totals[day][exe].titles[title] += durationMs;
  }

}

function addRunningDuration(exe, durationMs, endMs) {
  const cleanExe = normalizeExe(exe) || "unknown.exe";
  if (durationMs <= 0 || isRunningWhitelisted(cleanExe)) return;
  const day = todayKey(endMs);
  db.runningTotals[day] ||= {};
  db.runningTotals[day][cleanExe] ||= { ms: 0 };
  db.runningTotals[day][cleanExe].ms += durationMs;
}

function closeCurrent(endMs) {
  if (!current) return;
  const durationMs = Math.max(0, endMs - current.startedAt);
  const nativeWindow = Boolean(current.nativeWindowTracking)
    || nativeWindowTrackingActive(endMs);
  if (!nativeWindow) addActiveDuration(current.activity, durationMs, endMs);
  if (!nativeWindow && shouldUseBrowserFallback(current)) {
    addBrowserDuration(getBrowserFallbackClassification(current.activity), durationMs, endMs);
  }
  if (!nativeWindow) recordSession(current.activity, current.startedAt, endMs, durationMs);
  current = null;
  saveDb();
}

function ingestForeground(sample) {
  const activity = sample.foreground && typeof sample.foreground === "object"
    ? sample.foreground
    : sample;
  const now = Number(sample.timestamp || activity.timestamp || Date.now());
  db.lastSeen = activity;

  if (sample.windows && typeof sample.windows === "object") {
    const windows = Array.isArray(sample.windows) ? sample.windows : [sample.windows];
    lastWindowSample = {
      timestamp: now,
      foregroundHwnd: String(activity.hwnd || ""),
      windows
    };
    ingestVisibleBrowserWindows(windows, now);
    ingestVisibleAppWindows(windows, now);
  }

  if (!current) {
    current = {
      key: activityKey(activity),
      startedAt: now,
      activity,
      browserExtensionReportedAt: 0,
      nativeBrowserTracking: isBrowserExe(exeFromActivity(activity)) && nativeBrowserTrackingActive(now),
      nativeWindowTracking: nativeWindowTrackingActive(now)
    };
    ensureAppClassification(activity);
    ensureBrowserFallbackClassification(activity);
    return;
  }

  const key = activityKey(activity);
  if (key !== current.key || now - current.startedAt > 10 * 60 * 1000) {
    closeCurrent(now);
    current = {
      key,
      startedAt: now,
      activity,
      browserExtensionReportedAt: 0,
      nativeBrowserTracking: isBrowserExe(exeFromActivity(activity)) && nativeBrowserTrackingActive(now),
      nativeWindowTracking: nativeWindowTrackingActive(now)
    };
  } else {
    current.activity = activity;
    if (isBrowserExe(exeFromActivity(activity)) && nativeBrowserTrackingActive(now)) {
      current.nativeBrowserTracking = true;
    }
    if (nativeWindowTrackingActive(now)) current.nativeWindowTracking = true;
  }
  ensureAppClassification(activity);
  ensureBrowserFallbackClassification(activity);
}

function ingestProcesses(sample) {
  const now = Number(sample.timestamp || Date.now());
  const processes = Array.isArray(sample.processes) ? sample.processes : [];
  const running = new Set(processes.map((item) => normalizeExe(item.exe || `${item.processName}.exe`)).filter(Boolean));
  db.lastProcesses = processes.slice(0, 500);

  if (lastProcessSample) {
    const durationMs = Math.min(5000, Math.max(0, now - lastProcessSample.timestamp));
    for (const exe of lastProcessSample.running) {
      addRunningDuration(exe, durationMs, now);
    }
    saveDb();
  }

  lastProcessSample = { timestamp: now, running };
  enforceBlockedBrowserProcesses(processes, now);
  enforceUnifiedEntertainmentLimit(processes, now);
}

function startJsonLineMonitor(scriptName, onLine, onExit) {
  const script = path.join(__dirname, scriptName);
  const child = spawn("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    script
  ], { windowsHide: true });

  child.stdout.on("data", onLine);
  child.stderr.on("data", () => {});
  child.on("exit", onExit);
  return child;
}

function startForegroundMonitor() {
  if (foregroundMonitor) return;
  foregroundMonitor = startJsonLineMonitor("foreground.ps1", (chunk) => {
    foregroundBuffer += chunk.toString("utf8");
    const lines = foregroundBuffer.split(/\r?\n/);
    foregroundBuffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        ingestForeground(JSON.parse(line));
      } catch {}
    }
  }, () => {
    foregroundMonitor = null;
    setTimeout(startForegroundMonitor, 2000);
  });
}

function startProcessMonitor() {
  if (processMonitor) return;
  processMonitor = startJsonLineMonitor("processes.ps1", (chunk) => {
    processBuffer += chunk.toString("utf8");
    const lines = processBuffer.split(/\r?\n/);
    processBuffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        ingestProcesses(JSON.parse(line));
      } catch {}
    }
  }, () => {
    processMonitor = null;
    setTimeout(startProcessMonitor, 2000);
  });
}

function startBrowserDownloadGuard() {
  if (browserDownloadGuard) return;
  browserDownloadGuard = startJsonLineMonitor("browser-download-guard.ps1", () => {}, () => {
    browserDownloadGuard = null;
    setTimeout(startBrowserDownloadGuard, 5000);
  });
}

function parseCookies(req) {
  return Object.fromEntries(String(req.headers.cookie || "")
    .split(";")
    .map((part) => part.trim().split("="))
    .filter((pair) => pair.length === 2));
}

function isAuthed(req) {
  if (!db.config.passwordHash) return false;
  const token = parseCookies(req).fg_token;
  return token && tokens.get(token) > Date.now();
}

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    ...headers
  });
  res.end(JSON.stringify(body));
}

function sendText(res, status, body, contentType = "text/plain; charset=utf-8", headers = {}) {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
    ...headers
  });
  res.end(body);
}

function browserExtensionMetadata() {
  if (!fs.existsSync(BROWSER_EXTENSION_METADATA_PATH)) return null;
  try {
    const metadataText = fs.readFileSync(BROWSER_EXTENSION_METADATA_PATH, "utf8").replace(/^\uFEFF/, "");
    const metadata = JSON.parse(metadataText);
    if (!/^[a-p]{32}$/.test(String(metadata.id || ""))) return null;
    return {
      id: metadata.id,
      version: String(metadata.version || "0.0.0")
    };
  } catch {
    return null;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

function publicFile(file) {
  const resolved = path.resolve(PUBLIC_DIR, file);
  if (!resolved.startsWith(PUBLIC_DIR)) return null;
  return resolved;
}

function activeSummary(day = todayKey()) {
  const totals = clone(db.totals[day] || {});
  const currentIsNativeWindow = Boolean(current
    && (current.nativeWindowTracking || nativeWindowTrackingActive()));
  if (current && !currentIsNativeWindow && day === todayKey() && !isActiveWhitelisted(current.activity)) {
    const now = Date.now();
    const durationMs = Math.max(0, now - current.startedAt);
    const exe = exeFromActivity(current.activity);
    totals[exe] ||= { ms: 0, titles: {} };
    totals[exe].ms += durationMs;

    const title = String(current.activity.title || "").trim();
    if (title) {
      totals[exe].titles[title] ||= 0;
      totals[exe].titles[title] += durationMs;
    }
  }

  if (day === todayKey()) {
    const now = Date.now();
    for (const session of visibleBrowserSessions.values()) {
      const durationMs = browserWindowPendingDuration(session, now);
      if (durationMs <= 0 || isActiveWhitelisted(session.activity)) continue;
      const exe = exeFromActivity(session.activity);
      totals[exe] ||= { ms: 0, titles: {} };
      totals[exe].ms += durationMs;
      const title = String(session.activity.title || "").trim();
      if (title) {
        totals[exe].titles[title] ||= 0;
        totals[exe].titles[title] += durationMs;
      }
    }
    for (const session of visibleAppSessions.values()) {
      const durationMs = appWindowPendingDuration(session, now);
      if (durationMs <= 0 || isActiveWhitelisted(session.activity)) continue;
      const exe = exeFromActivity(session.activity);
      totals[exe] ||= { ms: 0, titles: {} };
      totals[exe].ms += durationMs;
      const title = String(session.activity.title || "").trim();
      if (title) {
        totals[exe].titles[title] ||= 0;
        totals[exe].titles[title] += durationMs;
      }
    }
  }

  return Object.entries(totals)
    .map(([exe, value]) => ({
      exe,
      ms: Math.round(value.ms || 0),
      topTitles: Object.entries(value.titles || {})
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([title, ms]) => ({ title, ms: Math.round(ms) }))
    }))
    .sort((a, b) => b.ms - a.ms);
}

function getActiveMs(exe, day = todayKey()) {
  const row = activeSummary(day).find((item) => item.exe === normalizeExe(exe));
  return row ? row.ms : 0;
}

function getRunningMs(exe, day = todayKey()) {
  const row = runningSummary(day).find((item) => item.exe === normalizeExe(exe));
  return row ? row.ms : 0;
}

function runningSummary(day = todayKey()) {
  const totals = clone(db.runningTotals[day] || {});
  if (lastProcessSample && day === todayKey()) {
    const now = Date.now();
    const durationMs = Math.min(5000, Math.max(0, now - lastProcessSample.timestamp));
    for (const exe of lastProcessSample.running) {
      const cleanExe = normalizeExe(exe) || "unknown.exe";
      if (isRunningWhitelisted(cleanExe)) continue;
      totals[cleanExe] ||= { ms: 0 };
      totals[cleanExe].ms += durationMs;
    }
  }

  return Object.entries(totals)
    .map(([exe, value]) => ({ exe, ms: Math.round(value.ms || 0) }))
    .filter((row) => !isRunningWhitelisted(row.exe))
    .sort((a, b) => b.ms - a.ms);
}

function entertainmentLimitMinutes(ms = Date.now()) {
  const limits = db.config.entertainmentLimits || db.config.browserEntertainmentLimits || {};
  return currentDayType(ms) === "weekend"
    ? Number(limits.weekendMinutes || 0)
    : Number(limits.weekdayMinutes || 0);
}

function browserDayTotals(day = todayKey()) {
  return db.browserTotals[day] || {};
}

function browserEntertainmentEntryMs(item) {
  if (item.categoryMs && typeof item.categoryMs === "object") {
    return Object.entries(item.categoryMs)
      .filter(([category]) => isEntertainmentCategory(category))
      .reduce((sum, [, ms]) => sum + Number(ms || 0), 0);
  }
  return isEntertainmentCategory(item.category) ? Number(item.ms || 0) : 0;
}

function browserFallbackCurrentMs(day = todayKey(), now = Date.now()) {
  if (!current || day !== todayKey(now) || !shouldUseBrowserFallback(current)) return 0;

  const dayStart = new Date(`${day}T00:00:00`).getTime();
  const durationMs = Math.max(0, now - Math.max(current.startedAt, dayStart));
  return isEntertainmentCategory(getBrowserFallbackClassification(current.activity).category)
    ? durationMs
    : 0;
}

function browserWindowPendingDuration(session, now = Date.now()) {
  if (!session) return 0;
  const rawDurationMs = Math.min(5000, Math.max(0, now - session.lastSampleAt));
  return rawDurationMs * Math.min(1, Math.max(0, Number(session.visibleRatio || 0)));
}

function appWindowPendingDuration(session, now = Date.now()) {
  if (!session) return 0;
  const rawDurationMs = Math.min(5000, Math.max(0, now - session.lastSampleAt));
  return rawDurationMs * Math.min(1, Math.max(0, Number(session.visibleRatio || 0)));
}

function browserWindowPendingEntertainmentMs(day = todayKey(), now = Date.now()) {
  if (day !== todayKey(now)) return 0;
  return Array.from(visibleBrowserSessions.values())
    .filter((session) => !isActiveWhitelisted(session.activity))
    .reduce((sum, session) => {
      if (!isEntertainmentCategory(session.activity.browserClassification?.category)) return sum;
      return sum + browserWindowPendingDuration(session, now);
    }, 0);
}

function getBrowserEntertainmentMs(day = todayKey(), now = Date.now()) {
  return Object.values(browserDayTotals(day))
    .reduce((sum, item) => sum + browserEntertainmentEntryMs(item), 0)
    + browserFallbackCurrentMs(day, now)
    + browserWindowPendingEntertainmentMs(day, now);
}

function getAppEntertainmentMs(day = todayKey(), now = Date.now()) {
  let total = Object.entries(db.totals[day] || {})
    .filter(([exe]) => !isBrowserExe(exe) && !isAppWhitelisted(exe))
    .filter(([exe, value]) => isEntertainmentClassification(getAppClassification({
      exe,
      processName: exe.replace(/\.exe$/i, ""),
      title: Object.keys(value.titles || {}).pop() || ""
    })))
    .reduce((sum, [, value]) => sum + Number(value.ms || 0), 0);

  const currentIsNativeWindow = Boolean(current
    && (current.nativeWindowTracking || nativeWindowTrackingActive(now)));
  if (current && !currentIsNativeWindow && day === todayKey(now)) {
    const exe = exeFromActivity(current.activity);
    const classification = getAppClassification(current.activity);
    if (!isBrowserExe(exe) && !isActiveWhitelisted(current.activity) && isEntertainmentClassification(classification)) {
      const dayStart = new Date(`${day}T00:00:00`).getTime();
      total += Math.max(0, now - Math.max(current.startedAt, dayStart));
    }
  }

  if (day === todayKey(now)) {
    for (const session of visibleAppSessions.values()) {
      const exe = exeFromActivity(session.activity);
      const classification = getAppClassification(session.activity);
      const durationMs = appWindowPendingDuration(session, now);
      if (durationMs <= 0
        || isBrowserExe(exe)
        || isActiveWhitelisted(session.activity)
        || !isEntertainmentClassification(classification)) continue;
      total += durationMs;
    }
  }
  return total;
}

function appEntertainmentRows(day = todayKey(), now = Date.now()) {
  const rows = Object.entries(db.totals[day] || [])
    .map(([exe, value]) => {
      const title = Object.keys(value.titles || {}).pop() || "";
      const classification = getAppClassification({
        exe,
        processName: exe.replace(/\.exe$/i, ""),
        title
      });
      return {
        name: exe,
        source: "软件",
        category: classification.category,
        title,
        ms: Math.round(value.ms || 0),
        include: !isBrowserExe(exe)
          && !isAppWhitelisted(exe)
          && isEntertainmentClassification(classification)
      };
    })
    .filter((row) => row.include)
    .map(({ include, ...row }) => row);

  const currentIsNativeWindow = Boolean(current
    && (current.nativeWindowTracking || nativeWindowTrackingActive(now)));
  if (current && !currentIsNativeWindow && day === todayKey(now)) {
    const exe = exeFromActivity(current.activity);
    const classification = getAppClassification(current.activity);
    if (!isBrowserExe(exe) && !isActiveWhitelisted(current.activity) && isEntertainmentClassification(classification)) {
      const dayStart = new Date(`${day}T00:00:00`).getTime();
      const durationMs = Math.max(0, now - Math.max(current.startedAt, dayStart));
      const row = rows.find((item) => item.name === exe);
      if (row) row.ms += Math.round(durationMs);
      else rows.push({ name: exe, source: "软件", category: classification.category, title: current.activity.title || "", ms: Math.round(durationMs) });
    }
  }

  if (day === todayKey(now)) {
    for (const session of visibleAppSessions.values()) {
      const exe = exeFromActivity(session.activity);
      const classification = getAppClassification(session.activity);
      const durationMs = appWindowPendingDuration(session, now);
      if (durationMs <= 0
        || isBrowserExe(exe)
        || isActiveWhitelisted(session.activity)
        || !isEntertainmentClassification(classification)) continue;
      const row = rows.find((item) => item.name === exe);
      if (row) {
        row.ms += Math.round(durationMs);
        row.title = session.activity.title || row.title;
      } else {
        rows.push({
          name: exe,
          source: "软件",
          category: classification.category,
          title: session.activity.title || "",
          ms: Math.round(durationMs)
        });
      }
    }
  }
  return rows.filter((row) => row.ms > 0);
}

function browserEntertainmentRows(day = todayKey(), now = Date.now()) {
  const rows = Object.entries(browserDayTotals(day))
    .map(([hostname, value]) => ({
      name: hostname,
      source: "网站",
      category: value.category || "entertainment",
      title: value.title || "",
      url: value.url || "",
      ms: Math.round(browserEntertainmentEntryMs(value))
    }))
    .filter((row) => row.ms > 0);

  const fallbackMs = browserFallbackCurrentMs(day, now);
  if (fallbackMs > 0) {
    const classification = getBrowserFallbackClassification(current.activity);
    if (isEntertainmentCategory(classification.category)) {
      const existing = rows.find((row) => row.name === "浏览器标签页");
      if (existing) {
        existing.ms += Math.round(fallbackMs);
        existing.title = classification.title || existing.title;
      } else {
        rows.push({
          name: "浏览器标签页",
          source: "网站",
          category: classification.category,
          title: classification.title,
          url: "",
          ms: Math.round(fallbackMs)
        });
      }
    }
  }

  if (day === todayKey()) {
    for (const session of visibleBrowserSessions.values()) {
      const durationMs = browserWindowPendingDuration(session, now);
      const classification = session.activity.browserClassification || getBrowserFallbackClassification(session.activity);
      if (durationMs <= 0 || isActiveWhitelisted(session.activity) || !isEntertainmentCategory(classification.category)) continue;
      const hostname = classification.hostname || "浏览器标签页";
      const existing = rows.find((row) => row.name === hostname);
      if (existing) {
        existing.ms += Math.round(durationMs);
        existing.title = classification.title || existing.title;
        existing.url = classification.url || existing.url;
      } else {
        rows.push({
          name: hostname,
          source: "网站",
          category: classification.category,
          title: classification.title || session.activity.title || "",
          url: classification.url || session.activity.browserUrl || "",
          ms: Math.round(durationMs)
        });
      }
    }
  }
  return rows;
}

function getUnifiedEntertainmentMs(day = todayKey(), now = Date.now()) {
  return getAppEntertainmentMs(day, now) + getBrowserEntertainmentMs(day, now);
}

function entertainmentRows(day = todayKey(), now = Date.now()) {
  return [...appEntertainmentRows(day, now), ...browserEntertainmentRows(day, now)]
    .sort((a, b) => b.ms - a.ms);
}

function filterAdminSummaryRows(rows) {
  return rows.filter((row) => Number(row.ms || 0) >= ADMIN_SUMMARY_MIN_MS);
}

function normalizeAppExecutable(value) {
  const raw = String(value || "").trim().replace(/^.*[\\/]/, "");
  const exe = normalizeExe(raw);
  return /^[a-z0-9_. -]+\.exe$/i.test(exe) ? exe : "";
}

function unknownAppRows(day = todayKey()) {
  const candidates = new Map();
  const dayTotals = db.totals[day] || {};
  const dayRunningTotals = db.runningTotals[day] || {};

  function addCandidate(rawExe, title = "", activity = {}) {
    const exe = normalizeAppExecutable(rawExe);
    if (!exe || isBrowserExe(exe) || isRunningWhitelisted(exe) || manualAppClassification(exe)) return;

    const classification = getAppClassification({
      ...activity,
      exe,
      processName: activity.processName || exe.replace(/\.exe$/i, ""),
      title: title || activity.title || ""
    });
    if (classification.category !== "unknown" && !classification.needsResearch) return;

    const total = Number(dayTotals[exe]?.ms || 0);
    const running = Number(dayRunningTotals[exe]?.ms || 0);
    const previous = candidates.get(exe);
    candidates.set(exe, {
      exe,
      title: title || activity.title || previous?.title || "",
      ms: Math.round(Math.max(total, previous?.ms || 0)),
      runningMs: Math.round(Math.max(running, previous?.runningMs || 0)),
      confidence: Number(classification.confidence || 0),
      reason: String(classification.reason || "AI 尚未确认软件用途"),
      needsResearch: Boolean(classification.needsResearch)
    });
  }

  for (const [exe, cached] of Object.entries(db.appClassificationCache || {})) {
    if (cached?.result?.category === "unknown" || cached?.result?.needsResearch) {
      addCandidate(exe, "", {}, cached.result);
    }
  }

  for (const [exe, value] of Object.entries(dayTotals)) {
    const title = Object.keys(value.titles || {}).sort((a, b) => value.titles[b] - value.titles[a])[0] || "";
    addCandidate(exe, title);
  }

  for (const process of db.lastProcesses || []) {
    addCandidate(process.exe || `${process.processName || ""}.exe`, "", process);
  }

  if (db.lastSeen) addCandidate(db.lastSeen.exe, db.lastSeen.title, db.lastSeen);

  return Array.from(candidates.values())
    .sort((a, b) => (b.ms - a.ms) || (b.runningMs - a.runningMs) || a.exe.localeCompare(b.exe));
}

function browserDisplayName(exe) {
  const names = {
    "msedge.exe": "Microsoft Edge",
    "chrome.exe": "Google Chrome",
    "firefox.exe": "Firefox",
    "brave.exe": "Brave",
    "opera.exe": "Opera"
  };
  return names[normalizeExe(exe)] || exe;
}

const liveStatusDefinitions = [
  { key: "active_counted", label: "正在使用 · 计入总时长" },
  { key: "active_excluded", label: "正在使用 · 不计入总时长" },
  { key: "background", label: "处于后台 · 不计时" },
  { key: "minimized", label: "已最小化 · 不计时" },
  { key: "covered", label: "被遮挡 · 不计时" },
  { key: "unavailable", label: "暂未采样" }
];

function emptyLiveStatusGroups() {
  return Object.fromEntries(liveStatusDefinitions.map(({ key }) => [key, []]));
}

function liveWindowSummary(now = Date.now()) {
  const sample = lastWindowSample;
  if (!sample || now - Number(sample.timestamp || 0) > 5000) {
    const groups = emptyLiveStatusGroups();
    return {
      updatedAt: sample?.timestamp || 0,
      stale: true,
      statusDefinitions: liveStatusDefinitions,
      windows: [],
      groups,
      counts: Object.fromEntries(liveStatusDefinitions.map(({ key }) => [key, 0])),
      timingWindows: [],
      pausedWindows: []
    };
  }

  const windows = (Array.isArray(sample.windows) ? sample.windows : [])
    .map((window, index) => ({
      ...window,
      zIndex: Number.isFinite(Number(window.zIndex)) ? Number(window.zIndex) : index
    }))
    .filter((window) => window.exe || window.processName);
  const foregroundHwnd = String(sample.foregroundHwnd || db.lastSeen?.hwnd || "");
  const groups = emptyLiveStatusGroups();

  for (const window of windows) {
    const exe = normalizeExe(window.exe || `${window.processName || "unknown"}.exe`);
    const title = String(window.title || "").trim();
    const minimized = Boolean(window.minimized);
    const isBrowser = isBrowserExe(exe);
    const foreground = String(window.hwnd || "") === foregroundHwnd;

    if (!title && !isBrowser && !foreground) continue;
    if (!foreground && !isBrowser && isRunningWhitelisted(exe) && !isAppWhitelisted(exe)) continue;

    let activity = window;
    let visiblePercent = isBrowser ? 0 : (minimized ? 0 : 100);
    let whitelisted = isActiveWhitelisted(window);
    let status = "background";
    let reason = "";
    let classification = isBrowser
      ? { category: "unknown", isEntertainment: false }
      : getAppClassification(window);
    let category = classification.category;
    let url = "";
    let displayName = window.processName || exe;

    if (isBrowser) {
      const session = visibleBrowserSessions.get(browserWindowKey(window));
      if (session) {
        activity = session.activity;
        visiblePercent = Math.round(Math.min(1, Math.max(0, Number(session.visibleRatio || 0))) * 100);
        classification = activity.browserClassification || { category: "unknown", isEntertainment: false };
        category = classification.category;
        url = activity.browserUrl || activity.browserClassification?.url || "";
        displayName = browserDisplayName(exe);
        whitelisted = isActiveWhitelisted(activity);
      } else {
        visiblePercent = Math.round(visibleWindowRatio(window, windows) * 100);
        displayName = browserDisplayName(exe);
      }
      if (minimized) status = "minimized";
      else if (!nativeBrowserTrackingActive(now)) status = "unavailable";
      else if (visiblePercent <= 0) status = "covered";
      else if (whitelisted) status = "active_excluded";
      else status = isEntertainmentClassification(classification) ? "active_counted" : "active_excluded";

      if (status === "minimized") reason = "窗口已最小化";
      else if (status === "unavailable") reason = "窗口采样暂时不可用";
      else if (status === "covered") reason = "被其他窗口遮挡或可见区域过小";
      else if (status === "active_excluded") reason = whitelisted
        ? "浏览器标题命中白名单"
        : "非娱乐内容，不计入总时长";
      else reason = visiblePercent >= 100 ? "窗口可见，计时中" : `窗口可见 ${visiblePercent}%，计时中`;
    } else {
      const session = visibleAppSessions.get(browserWindowKey(window));
      if (session) {
        activity = session.activity;
        visiblePercent = Math.round(Math.min(1, Math.max(0, Number(session.visibleRatio || 0))) * 100);
        classification = getAppClassification(activity);
        category = classification.category;
        whitelisted = isActiveWhitelisted(activity);
        displayName = activity.processName || activity.exe || displayName;
      } else if (!minimized) {
        visiblePercent = Math.round(visibleWindowRatio(window, windows) * 100);
      }

      if (minimized) status = "minimized";
      else if (!nativeWindowTrackingActive(now)) status = "unavailable";
      else if (visiblePercent <= 0) status = "covered";
      else if (whitelisted) status = "active_excluded";
      else status = isEntertainmentClassification(classification) ? "active_counted" : "active_excluded";

      if (status === "minimized") reason = "窗口已最小化";
      else if (status === "unavailable") reason = "窗口采样暂时不可用";
      else if (status === "covered") reason = "被其他窗口遮挡或可见区域过小";
      else if (status === "active_excluded") reason = whitelisted
        ? "软件白名单，不计入总时长"
        : "非娱乐内容，不计入总时长";
      else reason = foreground
        ? "当前前台窗口，计时中"
        : `窗口可见 ${visiblePercent}%，计时中`;
    }

    const row = {
      id: String(window.hwnd || `${exe}:${title}`),
      name: displayName,
      exe,
      title: String(activity.title || title || "无标题"),
      url,
      category,
      visiblePercent,
      visibilityLabel: isBrowser
        ? (visiblePercent > 0 ? `可见 ${visiblePercent}%` : "不可见")
        : (minimized ? "已最小化" : (visiblePercent > 0 ? `可见 ${visiblePercent}%` : "不可见")),
      foreground,
      minimized,
      isBrowser,
      status,
      statusLabel: liveStatusDefinitions.find((item) => item.key === status)?.label || status,
      timing: status === "active_counted",
      reason
    };
    groups[status].push(row);
  }

  const allRows = liveStatusDefinitions.flatMap(({ key }) => groups[key]);
  const timingWindows = groups.active_counted;
  const pausedWindows = allRows.filter((row) => row.status !== "active_counted");

  return {
    updatedAt: sample.timestamp,
    stale: false,
    statusDefinitions: liveStatusDefinitions,
    windows: allRows,
    groups,
    counts: Object.fromEntries(liveStatusDefinitions.map(({ key }) => [key, groups[key].length])),
    timingWindows: timingWindows.sort((a, b) => b.visiblePercent - a.visiblePercent),
    pausedWindows: pausedWindows.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"))
  };
}

function addBrowserDuration(classification, durationMs, endMs) {
  if (!classification || durationMs <= 0 || classification.category === "whitelist") return;
  const day = todayKey(endMs);
  const hostname = normalizePattern(classification.hostname || "unknown");
  db.browserTotals[day] ||= {};
  db.browserTotals[day][hostname] ||= {
    ms: 0,
    category: classification.category,
    categoryMs: {},
    title: classification.title || "",
    url: classification.url || ""
  };
  const row = db.browserTotals[day][hostname];
  row.ms += durationMs;
  row.category = classification.category;
  row.categoryMs ||= {};
  row.categoryMs[classification.category] = Number(row.categoryMs[classification.category] || 0) + durationMs;
  row.title = classification.title || row.title || "";
  row.url = classification.url || row.url || "";
}

function heuristicClassify(url, title) {
  const query = searchQueryFromUrl(url);
  const text = `${url.hostname} ${title || ""} ${query}`.toLowerCase();
  const entertainmentPatterns = [
    "bilibili", "youtube", "douyin", "tiktok", "netflix", "iqiyi", "youku",
    "twitch", "huya", "douyu", "weibo", "xiaohongshu", "reddit", "twitter",
    "x.com", "instagram", "facebook", "steam", "epicgames", "抖音", "短视频",
    "游戏", "小游戏", "直播", "娱乐", "腾讯视频", "爱奇艺", "优酷", "b站"
  ];
  const workPatterns = [
    "github", "gitlab", "stackoverflow", "openai", "deepseek", "docs.",
    "learn", "course", "office", "notion", "feishu", "larksuite"
  ];
  if (query && entertainmentPatterns.some((pattern) => text.includes(pattern))) {
    return { category: "entertainment", confidence: 0.9, reason: "搜索词命中娱乐规则" };
  }
  if (workPatterns.some((pattern) => text.includes(pattern))) return { category: "work", confidence: 0.75, reason: "命中工作/学习规则" };
  if (entertainmentPatterns.some((pattern) => text.includes(pattern))) return { category: "entertainment", confidence: 0.8, reason: "命中娱乐规则" };
  return { category: "unknown", confidence: 0.4, reason: "未命中本地规则" };
}

async function aiClassifyPage(url, title) {
  const key = deepSeekApiKey();
  const model = db.config.aiClassification?.model || DEFAULT_AI_MODEL;
  if (!key || !db.config.aiClassification?.enabled) return heuristicClassify(url, title);

  const prompt = [
    "你是网页用途分类器。只输出严格 JSON，不要输出解释文字。",
    "分类只能是 entertainment, work, study, shopping, social, news, tool, unknown。",
    "如果主要用途是视频、短视频、直播、游戏、娱乐八卦、社交刷信息流，归为 entertainment 或 social。",
    "搜索页要按搜索意图分类；例如搜索抖音、游戏、视频、直播，归为 entertainment。",
    "如果是开发、文档、办公、课程、搜索资料，归为 work 或 study。",
    `URL: ${url.href}`,
    `标题: ${title || ""}`,
    `搜索词: ${searchQueryFromUrl(url) || ""}`,
    '输出格式: {"category":"entertainment","confidence":0.0,"reason":"短原因"}'
  ].join("\n");

  let response;
  try {
    response = await fetch(DEEPSEEK_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${key}`
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: "你只输出可解析的 JSON。" },
          { role: "user", content: prompt }
        ],
        stream: false,
        temperature: 0
      })
    });
  } catch {
    return { ...heuristicClassify(url, title), reason: "AI 请求失败，已使用本地规则" };
  }

  if (!response.ok) {
    return { ...heuristicClassify(url, title), reason: `AI 请求失败，已使用本地规则：HTTP ${response.status}` };
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || "";
  try {
    const parsed = JSON.parse(content.replace(/^```json\s*/i, "").replace(/```$/i, "").trim());
    const category = normalizePattern(parsed.category);
    const allowed = new Set(["entertainment", "work", "study", "shopping", "social", "news", "tool", "unknown"]);
    return {
      category: allowed.has(category) ? category : "unknown",
      confidence: Number(parsed.confidence || 0),
      reason: String(parsed.reason || "AI 分类")
    };
  } catch {
    return { ...heuristicClassify(url, title), reason: "AI 输出无法解析，已使用本地规则" };
  }
}

async function classifyPage(rawUrl, title = "") {
  const url = normalizeUrl(rawUrl);
  if (!url) return { category: "unknown", confidence: 0, reason: "URL 无效", hostname: "", url: rawUrl, title };

  const query = searchQueryFromUrl(url);
  const cacheKey = query
    ? `${url.hostname}${url.pathname}?q=${query}`.toLowerCase()
    : `${url.hostname}${url.pathname}`.toLowerCase();
  const strongLocalResult = heuristicClassify(url, title);
  if (strongLocalResult.category === "entertainment" && strongLocalResult.confidence >= 0.9) {
    const result = { ...strongLocalResult, hostname: url.hostname, url: url.href, title };
    if (JSON.stringify(db.classificationCache[cacheKey]?.result || {}) !== JSON.stringify(strongLocalResult)) {
      db.classificationCache[cacheKey] = { timestamp: Date.now(), result: strongLocalResult };
      saveDb();
    }
    return result;
  }
  const cached = db.classificationCache[cacheKey];
  if (cached && Date.now() - Number(cached.timestamp || 0) < 7 * 24 * 60 * 60 * 1000) {
    return { ...cached.result, hostname: url.hostname, url: url.href, title };
  }

  const result = await aiClassifyPage(url, title);
  db.classificationCache[cacheKey] = {
    timestamp: Date.now(),
    result
  };
  saveDb();
  return { ...result, hostname: url.hostname, url: url.href, title };
}

function isBrowserVisitWhitelisted(rawUrl, title = "") {
  const normalizedTitle = normalizePattern(title);
  const titleMatched = db.config.browserTitleWhitelist
    .map(normalizePattern)
    .filter(Boolean)
    .some((pattern) => normalizedTitle.includes(pattern));
  if (titleMatched) return true;
  return false;
}

function storeBrowserExtensionHint(body, classification, now = Date.now()) {
  const key = String(body.windowId ?? "legacy");
  browserExtensionHints.set(key, {
    windowId: body.windowId ?? "legacy",
    tabId: Number(body.tabId || 0),
    url: String(body.url || ""),
    title: String(body.title || ""),
    windowBounds: body.windowBounds && typeof body.windowBounds === "object" ? body.windowBounds : null,
    windowFocused: Boolean(body.windowFocused),
    windowState: String(body.windowState || "normal"),
    classification,
    seenAt: now
  });
  pruneBrowserExtensionHints(now);
  while (browserExtensionHints.size > 100) {
    const oldest = Array.from(browserExtensionHints.entries())
      .sort((a, b) => Number(a[1].seenAt || 0) - Number(b[1].seenAt || 0))[0];
    if (!oldest) break;
    browserExtensionHints.delete(oldest[0]);
  }
}

function recordLimitEvent(limit, usageMs, now, result = {}) {
  db.limitEvents.push({
    timestamp: now,
    day: todayKey(now),
    exe: limit.exe,
    mode: limit.mode,
    dayType: normalizeDayType(limit.dayType),
    minutes: limit.minutes,
    usageMs,
    action: limit.action,
    ok: result.ok !== false,
    message: result.message || ""
  });
  if (db.limitEvents.length > 500) db.limitEvents = db.limitEvents.slice(-500);
  if (result.ok === false) db.lastLimitError = result.message || "关闭进程失败";
  if (result.ok !== false) db.lastLimitError = null;
  saveDb();
}

function closeApp(exe, onResult) {
  const child = spawn("taskkill.exe", ["/IM", exe, "/F", "/T"], { windowsHide: true });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString("utf8");
  });
  child.on("exit", (code) => {
    onResult({
      ok: code === 0,
      message: code === 0 ? output.trim() : "关闭失败：权限不足或目标进程受保护，请以管理员权限运行 FocusGuard。"
    });
  });
}

function closeBrowserTabNative(hwnd, onResult = () => {}) {
  const script = path.join(__dirname, "close-browser-tab.ps1");
  const targetHwnd = Number(hwnd);
  if (!Number.isFinite(targetHwnd) || targetHwnd <= 0) {
    onResult({ ok: false, message: "浏览器窗口句柄无效" });
    return;
  }

  const child = spawn("powershell.exe", [
    "-NoProfile",
    "-WindowStyle",
    "Hidden",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    script,
    "-Hwnd",
    String(Math.trunc(targetHwnd))
  ], { windowsHide: true });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString("utf8");
  });
  child.on("error", (error) => onResult({ ok: false, message: error.message }));
  child.on("exit", (code) => onResult({
    ok: code === 0,
    message: code === 0 ? output.trim() : "原生浏览器标签关闭失败"
  }));
}

function enforceNativeBrowserEntertainmentLimit(now = Date.now()) {
  const limitMinutes = entertainmentLimitMinutes(now);
  if (limitMinutes <= 0) return;

  const usageMs = getUnifiedEntertainmentMs(todayKey(now), now);
  if (usageMs < limitMinutes * 60 * 1000) {
    nativeBrowserLimitFirstSeen.clear();
    return;
  }

  const candidates = new Set();
  for (const session of visibleBrowserSessions.values()) {
    const hwnd = Number(session.activity?.hwnd || 0);
    const classification = session.activity?.browserClassification
      || getBrowserFallbackClassification(session.activity || {});
    const visibleRatio = Number(session.visibleRatio || 0);
    if (!hwnd || visibleRatio <= 0 || !isEntertainmentClassification(classification)) continue;

    const key = String(hwnd);
    candidates.add(key);
    const firstSeen = nativeBrowserLimitFirstSeen.get(key) || now;
    nativeBrowserLimitFirstSeen.set(key, firstSeen);

    const extensionSeenAt = Number(session.activity?.browserExtensionReportedAt || 0);
    const extensionFresh = extensionSeenAt > 0 && now - extensionSeenAt <= 60 * 1000;
    const extensionGraceActive = extensionFresh && now - firstSeen < 5 * 1000;
    if (extensionGraceActive) continue;

    const lastAction = lastNativeBrowserCloseActions.get(key) || 0;
    if (now - lastAction < 15 * 1000) continue;
    lastNativeBrowserCloseActions.set(key, now);

    closeBrowserTabNative(hwnd, () => {});
  }

  for (const key of nativeBrowserLimitFirstSeen.keys()) {
    if (!candidates.has(key)) nativeBrowserLimitFirstSeen.delete(key);
  }
}

function enforceBlockedBrowserProcesses(processes, now = Date.now()) {
  const blocked = new Set((db.config.blockedBrowserExes || []).map(normalizeExe));
  const executables = new Set(processes
    .map((item) => normalizeExe(item.exe || `${item.processName}.exe`))
    .filter((exe) => exe && blocked.has(exe)));

  for (const exe of executables) {
    const lastAction = lastBrowserBlockActions.get(exe) || 0;
    if (now - lastAction < 30 * 1000) continue;
    lastBrowserBlockActions.set(exe, now);
    closeApp(exe, () => {});
  }
}

function entertainmentProcessExes(processes) {
  return Array.from(new Set(processes
    .map((item) => ({
      exe: normalizeExe(item.exe || `${item.processName}.exe`),
      processName: item.processName || ""
    }))
    .filter((item) => item.exe && !isBrowserExe(item.exe) && !isAppWhitelisted(item.exe))
    .filter((item) => isEntertainmentClassification(getAppClassification(item)))
    .map((item) => item.exe)));
}

function enforceUnifiedEntertainmentLimit(processes, now = Date.now()) {
  const limitMinutes = entertainmentLimitMinutes(now);
  if (limitMinutes <= 0) return;

  const usageMs = getUnifiedEntertainmentMs(todayKey(now), now);
  if (usageMs < limitMinutes * 60 * 1000) return;

  for (const exe of entertainmentProcessExes(processes)) {
    const cooldownKey = `${todayKey(now)}|unified|${exe}`;
    const lastAction = lastLimitActions.get(cooldownKey) || 0;
    if (now - lastAction < 30 * 1000) continue;

    lastLimitActions.set(cooldownKey, now);
    closeApp(exe, (result) => recordLimitEvent({
      exe,
      mode: "unified",
      minutes: limitMinutes,
      dayType: currentDayType(now),
      action: "close"
    }, usageMs, now, result));
  }
}

function clearStaleLimitError() {
  if (!db.lastLimitError || !lastProcessSample) return;
  const limitMinutes = entertainmentLimitMinutes();
  const stillLimited = limitMinutes > 0
    && getUnifiedEntertainmentMs() >= limitMinutes * 60 * 1000
    && entertainmentProcessExes(db.lastProcesses || []).length > 0;
  if (!stillLimited) {
    db.lastLimitError = null;
    saveDb();
  }
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === "OPTIONS") return sendJson(res, 200, { ok: true });

  if (url.pathname === "/api/browser-extension/update.xml" && req.method === "GET") {
    const metadata = browserExtensionMetadata();
    if (!metadata) return sendText(res, 404, "FocusGuard browser extension is not packaged.");
    const codebase = `http://127.0.0.1:${PORT}/api/browser-extension/focusguard.crx`;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n`
      + `<gupdate xmlns="http://www.google.com/update2/response" protocol="2.0">`
      + `<app appid="${metadata.id}"><updatecheck codebase="${codebase}" version="${metadata.version}" />`
      + `</app></gupdate>`;
    return sendText(res, 200, xml, "application/xml; charset=utf-8");
  }

  if (url.pathname === "/api/browser-extension/focusguard.crx" && req.method === "GET") {
    const crxPath = path.join(BROWSER_EXTENSION_DIR, "focusguard.crx");
    if (!fs.existsSync(crxPath)) return sendText(res, 404, "FocusGuard browser extension is not packaged.");
    const payload = fs.readFileSync(crxPath);
    res.writeHead(200, {
      "Content-Type": "application/x-chrome-extension",
      "Content-Length": payload.length,
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*"
    });
    return res.end(payload);
  }

  if (url.pathname === "/api/status") {
    clearStaleLimitError();
    const daySchedule = currentDaySchedule();
    return sendJson(res, 200, {
      configured: Boolean(db.config.passwordHash),
      authed: isAuthed(req),
      monitoring: Boolean(foregroundMonitor && processMonitor && browserDownloadGuard),
      foregroundMonitoring: Boolean(foregroundMonitor),
      nativeBrowserWindowMonitoring: nativeBrowserTrackingActive(),
      visibleBrowserWindowCount: visibleBrowserWindowCount(),
      processMonitoring: Boolean(processMonitor),
      browserDownloadGuardMonitoring: Boolean(browserDownloadGuard),
      browserExtensionLastSeenAt: lastBrowserExtensionSeenAt,
      browserExtensionOnline: lastBrowserExtensionSeenAt > 0
        && Date.now() - lastBrowserExtensionSeenAt <= 60 * 1000,
      lastSeen: db.lastSeen,
      runningCount: lastProcessSample ? lastProcessSample.running.size : 0,
      lastLimitError: db.lastLimitError,
      deepSeekConfigured: Boolean(deepSeekApiKey()),
      entertainmentTotalMs: Math.round(getUnifiedEntertainmentMs()),
      entertainmentLimitMinutes: entertainmentLimitMinutes(),
      today: todayKey(),
      dayType: daySchedule.dayType,
      dayLabel: daySchedule.dayLabel,
      dayReason: daySchedule.dayReason
    });
  }

  if (url.pathname === "/api/child-summary") {
    const day = todayKey();
    const browserRows = Object.entries(browserDayTotals(day))
      .map(([hostname, value]) => ({ hostname, ...value, ms: Math.round(value.ms || 0) }))
      .filter((row) => row.category === "entertainment" || row.category === "social")
      .sort((a, b) => b.ms - a.ms);
    const browserEntertainmentMs = Math.round(getBrowserEntertainmentMs(day));
    const appRows = appEntertainmentRows(day);
    const totalMs = Math.round(getUnifiedEntertainmentMs(day));
    const entertainmentLimitMinutesValue = entertainmentLimitMinutes();
    const liveWindows = liveWindowSummary();
    const daySchedule = currentDaySchedule();
    return sendJson(res, 200, {
      day,
      dayType: currentDayType(),
      dayLabel: daySchedule.dayLabel,
      dayReason: daySchedule.dayReason,
      monitoring: Boolean(foregroundMonitor && processMonitor && browserDownloadGuard),
      nativeBrowserWindowMonitoring: nativeBrowserTrackingActive(),
      visibleBrowserWindowCount: visibleBrowserWindowCount(),
      browserDownloadGuardMonitoring: Boolean(browserDownloadGuard),
      browserRows,
      appEntertainmentRows: appRows,
      entertainmentRows: entertainmentRows(day),
      browserEntertainmentMs,
      browserEntertainmentLimitMs: entertainmentLimitMinutesValue * 60 * 1000,
      entertainmentTotalMs: totalMs,
      entertainmentLimitMs: entertainmentLimitMinutesValue * 60 * 1000,
      entertainmentLimitMinutes: entertainmentLimitMinutesValue,
      liveWindows
    });
  }

  if (url.pathname === "/api/login" && req.method === "POST") {
    const body = await readBody(req);
    if (!verifyPassword(body.password || "")) return sendJson(res, 401, { error: "密码不正确" });
    const token = crypto.randomBytes(24).toString("hex");
    tokens.set(token, Date.now() + 12 * 60 * 60 * 1000);
    return sendJson(res, 200, { ok: true }, { "Set-Cookie": `fg_token=${token}; HttpOnly; SameSite=Lax; Path=/` });
  }

  if (url.pathname === "/api/setup" && req.method === "POST") {
    if (db.config.passwordHash && !isAuthed(req)) return sendJson(res, 401, { error: "未授权" });
    const body = await readBody(req);
    if (!body.password || String(body.password).length < 6) return sendJson(res, 400, { error: "密码至少需要 6 位" });
    const { salt, hash } = hashPassword(body.password);
    db.config.passwordSalt = salt;
    db.config.passwordHash = hash;
    saveDb();
    return sendJson(res, 200, { ok: true });
  }

  if (url.pathname === "/api/summary") {
    if (!isAuthed(req)) return sendJson(res, 401, { error: "未授权" });
    const day = url.searchParams.get("day") || todayKey();
    return sendJson(res, 200, { day, rows: activeSummary(day) });
  }

  if (url.pathname === "/api/summaries") {
    if (!isAuthed(req)) return sendJson(res, 401, { error: "未授权" });
    const day = url.searchParams.get("day") || todayKey();
    const daySchedule = currentDaySchedule();
    return sendJson(res, 200, {
      day,
      dayType: daySchedule.dayType,
      dayLabel: daySchedule.dayLabel,
      dayReason: daySchedule.dayReason,
      activeRows: filterAdminSummaryRows(activeSummary(day)),
      runningRows: runningSummary(day),
      nativeBrowserWindowMonitoring: nativeBrowserTrackingActive(),
      visibleBrowserWindowCount: visibleBrowserWindowCount(),
      browserRows: Object.entries(browserDayTotals(day))
        .map(([hostname, value]) => ({ hostname, ...value, ms: Math.round(value.ms || 0) }))
        .sort((a, b) => b.ms - a.ms),
      appEntertainmentRows: filterAdminSummaryRows(appEntertainmentRows(day)),
      entertainmentRows: filterAdminSummaryRows(entertainmentRows(day)),
      unknownApps: unknownAppRows(day),
      browserEntertainmentMs: Math.round(getBrowserEntertainmentMs(day)),
      browserEntertainmentLimitMinutes: entertainmentLimitMinutes(),
      entertainmentTotalMs: Math.round(getUnifiedEntertainmentMs(day)),
      entertainmentLimitMinutes: entertainmentLimitMinutes(),
      minimumDisplayMinutes: ADMIN_SUMMARY_MINUTES,
      entertainmentLimitMs: entertainmentLimitMinutes() * 60 * 1000
    });
  }

  if (url.pathname === "/api/app-classifications") {
    if (!isAuthed(req)) return sendJson(res, 401, { error: "未授权" });
    if (req.method === "GET") {
      return sendJson(res, 200, {
        unknownApps: unknownAppRows(),
        categories: Array.from(MANUAL_APP_CATEGORIES)
      });
    }
    if (req.method === "POST") {
      const body = await readBody(req);
      const exe = normalizeAppExecutable(body.exe);
      const category = normalizeManualAppCategory(body.category);
      if (!exe) return sendJson(res, 400, { error: "软件名称无效" });
      if (!category) return sendJson(res, 400, { error: "软件分组无效" });

      if (category === "unknown") {
        delete db.config.appClassificationOverrides[exe];
      } else {
        db.config.appClassificationOverrides[exe] = {
          category,
          updatedAt: Date.now()
        };
      }
      saveDb();
      return sendJson(res, 200, {
        ok: true,
        exe,
        category,
        unknownApps: unknownAppRows()
      });
    }
  }

  if (url.pathname === "/api/browser/visit" && req.method === "POST") {
    const body = await readBody(req);
    const now = Date.now();
    const durationMs = Math.min(30000, Math.max(0, Number(body.durationMs || 0)));
    lastBrowserExtensionSeenAt = now;
    if (current && isBrowserExe(exeFromActivity(current.activity))) {
      current.browserExtensionReportedAt = now;
    }
    const whitelisted = isBrowserVisitWhitelisted(body.url || "", body.title || "");
    const classification = whitelisted
      ? {
        category: "whitelist",
        confidence: 1,
        reason: "浏览器标题命中白名单",
        hostname: "白名单网站",
        url: String(body.url || ""),
        title: String(body.title || "")
      }
      : await classifyPage(body.url || "", body.title || "");
    storeBrowserExtensionHint(body, classification, now);

    // Native window sampling owns elapsed time. Keep the duration field only
    // for older extensions or during native-monitor startup/failure.
    if (!nativeBrowserTrackingActive(now)) addBrowserDuration(classification, durationMs, now);
    saveDb();

    const limitMinutes = entertainmentLimitMinutes(now);
    const browserEntertainmentMs = getBrowserEntertainmentMs(todayKey(now), now);
    const entertainmentTotalMs = getUnifiedEntertainmentMs(todayKey(now), now);
    const shouldClose = isEntertainmentClassification(classification)
      && limitMinutes > 0
      && entertainmentTotalMs >= limitMinutes * 60 * 1000;
    return sendJson(res, 200, {
      ok: true,
      classification,
      browserEntertainmentMs: Math.round(browserEntertainmentMs),
      entertainmentMs: Math.round(entertainmentTotalMs),
      entertainmentTotalMs: Math.round(entertainmentTotalMs),
      entertainmentLimitMinutes: limitMinutes,
      action: shouldClose && body.tabId ? "close-tab" : "allow"
    });
  }

  if (url.pathname === "/api/config") {
    if (!isAuthed(req)) return sendJson(res, 401, { error: "未授权" });
    if (req.method === "GET") return sendJson(res, 200, db.config);
    if (req.method === "POST") {
      const body = await readBody(req);
      db.config.appWhitelist = Array.isArray(body.appWhitelist) ? body.appWhitelist.map(normalizeExe).filter(Boolean) : db.config.appWhitelist;
      db.config.runningAppWhitelist = Array.isArray(body.runningAppWhitelist) ? body.runningAppWhitelist.map(normalizeExe).filter(Boolean) : db.config.runningAppWhitelist;
      db.config.browserApps = Array.isArray(body.browserApps) ? body.browserApps.map(normalizeExe).filter(Boolean) : db.config.browserApps;
      db.config.browserTitleWhitelist = Array.isArray(body.browserTitleWhitelist) ? body.browserTitleWhitelist.map(normalizePattern).filter(Boolean) : db.config.browserTitleWhitelist;
      const entertainmentLimits = body.entertainmentLimits || body.browserEntertainmentLimits;
      if (entertainmentLimits && typeof entertainmentLimits === "object") {
        db.config.entertainmentLimits = normalizeEntertainmentLimits(entertainmentLimits);
        db.config.browserEntertainmentLimits = clone(db.config.entertainmentLimits);
      }
      if (body.schoolBreaks && typeof body.schoolBreaks === "object") {
        const schoolBreakError = validateSchoolBreaks(body.schoolBreaks);
        if (schoolBreakError) return sendJson(res, 400, { error: schoolBreakError });
        db.config.schoolBreaks = normalizeSchoolBreaks(body.schoolBreaks);
      }
      if (body.aiClassification && typeof body.aiClassification === "object") {
        db.config.aiClassification = {
          enabled: Boolean(body.aiClassification.enabled),
          model: DEFAULT_AI_MODEL
        };
      }
      saveDb();
      return sendJson(res, 200, db.config);
    }
  }

  if (url.pathname === "/api/shutdown" && req.method === "POST") {
    const body = await readBody(req);
    if (!verifyPassword(body.password || "")) return sendJson(res, 401, { error: "密码不正确" });
    const now = Date.now();
    closeCurrent(now);
    flushVisibleBrowserSessions(now);
    flushVisibleAppSessions(now);
    saveDb();
    sendJson(res, 200, { ok: true });
    setTimeout(() => process.exit(0), 250);
    return;
  }

  const requestedFile = url.pathname === "/admin" || url.pathname === "/admin/"
    ? publicFile("admin.html")
    : publicFile(url.pathname === "/" ? "index.html" : url.pathname.slice(1));
  if (!requestedFile || !fs.existsSync(requestedFile) || fs.statSync(requestedFile).isDirectory()) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const ext = path.extname(requestedFile);
  const type = ext === ".css" ? "text/css; charset=utf-8" : ext === ".js" ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8";
  res.writeHead(200, {
    "Content-Type": type,
    "Cache-Control": "no-store, no-cache, must-revalidate",
    "Pragma": "no-cache",
    "Expires": "0"
  });
  fs.createReadStream(requestedFile).pipe(res);
}

function shutdown() {
  const now = Date.now();
  closeCurrent(now);
  flushVisibleBrowserSessions(now);
  flushVisibleAppSessions(now);
  saveDb();
  if (foregroundMonitor) foregroundMonitor.kill();
  if (processMonitor) processMonitor.kill();
  if (browserDownloadGuard) browserDownloadGuard.kill();
}

process.on("SIGINT", () => {
  shutdown();
  process.exit(0);
});

process.on("SIGTERM", () => {
  shutdown();
  process.exit(0);
});

startForegroundMonitor();
startProcessMonitor();
startBrowserDownloadGuard();
http.createServer((req, res) => route(req, res).catch((error) => sendJson(res, 500, { error: error.message })))
  .listen(PORT, "127.0.0.1", () => {
    console.log(`FocusGuard is running at http://127.0.0.1:${PORT}`);
  });
