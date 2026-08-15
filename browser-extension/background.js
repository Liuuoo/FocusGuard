const SERVICE_URL = "http://127.0.0.1:37831/api/browser/visit";
const TICK_SECONDS = 15;
const ALARM_NAME = "focusguard-tick";

const windowStates = new Map();
let stateLoaded = false;
let reportChain = Promise.resolve();

async function ensureState() {
  if (stateLoaded) return;
  stateLoaded = true;
  try {
    const saved = await chrome.storage.session.get(["windowStates"]);
    const stored = saved.windowStates && typeof saved.windowStates === "object"
      ? saved.windowStates
      : {};
    for (const [windowId, state] of Object.entries(stored)) {
      if (state && typeof state === "object") {
        windowStates.set(String(windowId), state);
      }
    }
  } catch {
    // Continue with in-memory state if session storage is unavailable.
  }
}

async function saveState() {
  try {
    await chrome.storage.session.set({ windowStates: Object.fromEntries(windowStates) });
  } catch {
    // In-memory state is sufficient while the worker remains active.
  }
}

function queueReport(force = false) {
  reportChain = reportChain
    .then(async () => {
      await ensureState();
      await reportActiveTab(force);
    })
    .catch(() => {});
  return reportChain;
}

async function ensureAlarm() {
  await chrome.alarms.create(ALARM_NAME, { periodInMinutes: TICK_SECONDS / 60 });
  await queueReport(true);
}

chrome.runtime.onInstalled.addListener(() => ensureAlarm());
chrome.runtime.onStartup.addListener(() => ensureAlarm());
ensureAlarm();

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) queueReport();
});

chrome.tabs.onActivated.addListener(() => queueReport(true));
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "complete" || changeInfo.url || changeInfo.title) {
    queueReport(true);
  }
});
chrome.tabs.onRemoved.addListener(() => queueReport(true));
chrome.windows.onFocusChanged.addListener(() => queueReport(true));
chrome.windows.onCreated.addListener(() => queueReport(true));
chrome.windows.onRemoved.addListener((windowId) => {
  windowStates.delete(String(windowId));
  queueReport(true);
});
if (chrome.windows.onBoundsChanged) {
  chrome.windows.onBoundsChanged.addListener(() => queueReport(true));
}

async function normalWindows() {
  return chrome.windows.getAll({ windowTypes: ["normal"] });
}

function isHttpUrl(url) {
  return /^https?:\/\//i.test(url || "");
}

function windowBounds(window) {
  if (!window || !Number.isFinite(window.left) || !Number.isFinite(window.top)
      || !Number.isFinite(window.width) || !Number.isFinite(window.height)) {
    return null;
  }
  return {
    left: window.left,
    top: window.top,
    width: window.width,
    height: window.height
  };
}

async function activeTab(windowId) {
  const tabs = await chrome.tabs.query({ active: true, windowId });
  return tabs[0] || null;
}

async function reportWindow(window, force = false) {
  const windowId = String(window.id);
  const tab = await activeTab(window.id);
  const now = Date.now();
  const state = windowStates.get(windowId) || {};
  const nextState = {
    tabId: tab?.id || 0,
    url: tab?.url || "",
    title: tab?.title || "",
    lastSentAt: now
  };
  const changed = state.tabId !== nextState.tabId
    || state.url !== nextState.url
    || state.title !== nextState.title
    || state.windowState !== window.state;
  const due = now - Number(state.lastSentAt || 0) >= TICK_SECONDS * 1000;
  const shouldSend = force || changed || due;

  windowStates.set(windowId, { ...nextState, windowState: window.state });
  if (!shouldSend) return;

  const payload = {
    windowId: window.id,
    windowFocused: Boolean(window.focused),
    windowState: window.state || "normal",
    windowBounds: windowBounds(window),
    tabId: tab?.id || 0,
    url: tab?.url || "",
    title: tab?.title || "",
    durationMs: 0
  };
  const data = await sendVisit(payload);
  if (data?.action === "close-tab" && tab?.id) {
    try {
      await chrome.tabs.remove(tab.id);
    } catch {
      // The tab may already have been closed by the user or policy.
    }
  }
}

async function reportAllWindows(force = false) {
  await ensureState();
  const windows = await normalWindows();
  const activeWindowIds = new Set(windows.map((window) => String(window.id)));

  for (const window of windows) {
    try {
      await reportWindow(window, force);
    } catch {
      // A window can disappear while it is being queried.
    }
  }

  for (const windowId of windowStates.keys()) {
    if (!activeWindowIds.has(windowId)) windowStates.delete(windowId);
  }
  await saveState();
}

async function reportActiveTab(force = false) {
  await reportAllWindows(force);
}

async function sendVisit(payload) {
  try {
    const response = await fetch(SERVICE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    return await response.json();
  } catch {
    // FocusGuard may be stopped; silently retry on the next tick.
    return null;
  }
}

/*
 * The native monitor owns elapsed time. This worker only reports the active
 * tab of every browser window so the service can classify it and match it to
 * the native window rectangle.
 */
async function flushLastTab() {
  await reportAllWindows(true);
}

/* Keep this function name for older service-worker state during an update. */
async function sendLegacyVisit(tab, durationMs) {
  if (!tab || !isHttpUrl(tab.url)) return null;
  return sendVisit({
    windowId: "legacy",
    windowFocused: true,
    windowState: "normal",
    windowBounds: null,
    tabId: tab.id || 0,
    url: tab.url,
    title: tab.title || "",
    durationMs: Math.max(0, Number(durationMs || 0))
  });
}
