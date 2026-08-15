const $ = (id) => document.getElementById(id);

const state = {
  configured: false,
  authed: false,
  configLoaded: false
};
const ADMIN_SUMMARY_MIN_MS = 3 * 60 * 1000;
const DEFAULT_AI_MODEL = "deepseek-v4-pro";
const APP_CATEGORY_OPTIONS = [
  ["unknown", "未知"],
  ["entertainment", "娱乐"],
  ["work", "工作"],
  ["study", "学习"],
  ["shopping", "购物"],
  ["social", "社交"],
  ["news", "新闻"],
  ["tool", "工具"]
];

function formatMs(ms) {
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes} 分钟`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} 小时 ${m} 分钟` : `${h} 小时`;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    ...options
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "请求失败");
  return data;
}

async function refreshStatus() {
  const status = await api("/api/status");
  state.configured = status.configured;
  state.authed = status.authed;
  $("statusText").textContent = status.lastLimitError
    ? `本地监控服务正在运行；上次关闭失败：${status.lastLimitError}`
    : status.monitoring ? "本地监控服务正在运行" : "监控服务未完全运行";
  $("monitorBadge").textContent = status.monitoring ? "运行中" : "部分运行";
  $("todayLabel").textContent = status.today + " · 前台累计 ≥3 分钟";
  if (!status.deepSeekConfigured && state.authed) {
    $("statusText").textContent += "；DeepSeek key 尚未配置";
  }

  const last = status.lastSeen || {};
  $("currentApp").textContent = last.exe || last.processName || "-";
  $("currentTitle").textContent = last.title || "-";

  $("authPanel").classList.toggle("hidden", state.authed);
  $("dashboard").classList.toggle("hidden", !state.authed);
  $("authTitle").textContent = state.configured ? "输入管理密码" : "设置管理密码";
  $("authBtn").textContent = state.configured ? "登录" : "设置密码";

  if (state.authed) {
    await loadSummaries();
    if (!state.configLoaded) await loadConfig();
  }
}

function renderSummary(list, rows, emptyText) {
  list.innerHTML = "";
  if (!rows.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = emptyText;
    list.appendChild(empty);
    return;
  }

  const max = Math.max(...rows.map((row) => row.ms));
  for (const row of rows) {
    const item = document.createElement("div");
    item.className = "summaryItem";
    if (row.topTitles) {
      item.title = row.topTitles.map((x) => `${x.title}: ${formatMs(x.ms)}`).join("\n");
    }
    item.innerHTML = `
      <strong>${row.exe}</strong>
      <div class="bar"><span style="width:${Math.max(4, (row.ms / max) * 100)}%"></span></div>
      <span>${formatMs(row.ms)}</span>
    `;
    list.appendChild(item);
  }
}

function categoryToChinese(category) {
  const map = {
    entertainment: "娱乐",
    work: "工作",
    study: "学习",
    shopping: "购物",
    social: "社交",
    news: "新闻",
    tool: "工具",
    unknown: "未知"
  };
  return map[category] || category || "未知";
}

function renderBrowserSummary(data) {
  const list = $("browserSummaryList");
  const rows = data.entertainmentRows || [];
  $("browserEntertainmentLabel").textContent = "前台累计 ≥3 分钟 · 娱乐总计 "
    + formatMs(data.entertainmentTotalMs || 0)
    + " / "
    + (data.entertainmentLimitMinutes || 0)
    + " 分钟";
  list.innerHTML = "";
  if (!rows.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "今天还没有达到 3 分钟的前台娱乐记录。";
    list.appendChild(empty);
    return;
  }

  const max = Math.max(...rows.map((row) => row.ms));
  for (const row of rows) {
    const item = document.createElement("div");
    item.className = "summaryItem";
    item.title = row.title || row.url || row.name;
    item.innerHTML = `
      <strong>${row.name}<small>${row.source} · ${categoryToChinese(row.category)}</small></strong>
      <div class="bar"><span style="width:${Math.max(4, (row.ms / max) * 100)}%"></span></div>
      <span>${formatMs(row.ms)}</span>
    `;
    list.appendChild(item);
  }
}

function renderUnknownApps(rows) {
  const list = $("unknownAppsList");
  const count = $("unknownAppCount");
  count.textContent = `${rows.length} 个`;
  list.innerHTML = "";

  if (!rows.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "没有待家长确认的软件。";
    list.appendChild(empty);
    return;
  }

  for (const row of rows) {
    const item = document.createElement("div");
    item.className = "unknownAppRow";

    const identity = document.createElement("div");
    identity.className = "unknownAppIdentity";
    const name = document.createElement("strong");
    name.textContent = row.exe;
    const detail = document.createElement("span");
    detail.textContent = row.title || row.reason || "AI 尚未确认用途";
    identity.append(name, detail);

    const usage = document.createElement("span");
    usage.className = "unknownAppUsage";
    usage.textContent = row.ms > 0
      ? `前台 ${formatMs(row.ms)}${row.runningMs > 0 ? ` · 运行 ${formatMs(row.runningMs)}` : ""}`
      : row.needsResearch ? "等待资料确认" : "尚无前台记录";

    const select = document.createElement("select");
    select.className = "unknownAppSelect";
    select.setAttribute("aria-label", `${row.exe} 的分组`);
    for (const [value, label] of APP_CATEGORY_OPTIONS) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      select.appendChild(option);
    }
    select.value = "unknown";

    const save = document.createElement("button");
    save.type = "button";
    save.textContent = "保存";
    save.addEventListener("click", () => saveAppClassification(row.exe, select.value));

    item.append(identity, usage, select, save);
    list.appendChild(item);
  }
}

async function saveAppClassification(exe, category) {
  const feedback = $("unknownAppsFeedback");
  feedback.textContent = "";
  feedback.classList.remove("error");
  try {
    await api("/api/app-classifications", {
      method: "POST",
      body: JSON.stringify({ exe, category })
    });
    feedback.textContent = `${exe} 已设置为“${categoryToChinese(category)}”`;
    await loadSummaries();
  } catch (error) {
    feedback.textContent = error.message;
    feedback.classList.add("error");
  }
}

async function loadSummaries() {
  const data = await api("/api/summaries");
  const activeRows = (data.activeRows || []).filter((row) => Number(row.ms || 0) >= ADMIN_SUMMARY_MIN_MS);
  const entertainmentRows = (data.entertainmentRows || []).filter((row) => Number(row.ms || 0) >= ADMIN_SUMMARY_MIN_MS);
  renderSummary($("activeSummaryList"), activeRows, "今天还没有达到 3 分钟的前台活跃记录。");
  renderBrowserSummary({ ...data, entertainmentRows });
  renderUnknownApps(data.unknownApps || []);
}

async function loadConfig() {
  const config = await api("/api/config");
  const entertainmentLimits = config.entertainmentLimits || config.browserEntertainmentLimits || {};
  $("entertainmentWeekdayLimit").value = entertainmentLimits.weekdayMinutes ?? 60;
  $("entertainmentWeekendLimit").value = entertainmentLimits.weekendMinutes ?? 120;
  $("aiEnabled").checked = Boolean(config.aiClassification?.enabled);
  $("aiModel").value = config.aiClassification?.model || DEFAULT_AI_MODEL;
  state.configLoaded = true;
}

async function handleAuth() {
  const password = $("passwordInput").value;
  try {
    if (state.configured) {
      await api("/api/login", { method: "POST", body: JSON.stringify({ password }) });
    } else {
      await api("/api/setup", { method: "POST", body: JSON.stringify({ password }) });
      await api("/api/login", { method: "POST", body: JSON.stringify({ password }) });
    }
    $("passwordInput").value = "";
    await refreshStatus();
  } catch (error) {
    alert(error.message);
  }
}

async function saveConfig() {
  const feedback = $("saveFeedback");
  feedback.textContent = "";
  feedback.classList.remove("error");
  try {
    await api("/api/config", {
      method: "POST",
      body: JSON.stringify({
        entertainmentLimits: {
          weekdayMinutes: Number($("entertainmentWeekdayLimit").value || 0),
          weekendMinutes: Number($("entertainmentWeekendLimit").value || 0)
        },
        aiClassification: {
          enabled: $("aiEnabled").checked,
          model: DEFAULT_AI_MODEL
        }
      })
    });
    state.configLoaded = false;
    await refreshStatus();
    feedback.textContent = "设置成功";
  } catch (error) {
    feedback.textContent = error.message;
    feedback.classList.add("error");
  }
}

async function shutdown() {
  const password = prompt("请输入管理密码以退出监控");
  if (!password) return;
  try {
    await api("/api/shutdown", { method: "POST", body: JSON.stringify({ password }) });
    $("statusText").textContent = "监控服务已退出";
  } catch (error) {
    alert(error.message);
  }
}

$("authBtn").addEventListener("click", handleAuth);
$("passwordInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter") handleAuth();
});
$("refreshBtn").addEventListener("click", refreshStatus);
$("saveConfigBtn").addEventListener("click", saveConfig);
$("shutdownBtn").addEventListener("click", shutdown);

refreshStatus().catch((error) => {
  $("statusText").textContent = error.message;
});

setInterval(() => {
  if (state.authed) refreshStatus().catch(() => {});
}, 5000);
