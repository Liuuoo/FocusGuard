const $ = (id) => document.getElementById(id);

const state = {
  configured: false,
  authed: false,
  configLoaded: false
};

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

function linesToArray(value) {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function arrayToLines(value) {
  return (value || []).join("\n");
}

async function refreshStatus() {
  const status = await api("/api/status");
  state.configured = status.configured;
  state.authed = status.authed;
  $("statusText").textContent = status.lastLimitError
    ? `本地监控服务正在运行；上次关闭失败：${status.lastLimitError}`
    : status.monitoring ? "本地监控服务正在运行" : "监控服务未完全运行";
  $("monitorBadge").textContent = status.monitoring ? "运行中" : "部分运行";
  $("todayLabel").textContent = status.today;
  $("runningCount").textContent = `${status.runningCount || 0} 个进程`;
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
  $("browserEntertainmentLabel").textContent = `娱乐总计 ${formatMs(data.entertainmentTotalMs || 0)} / ${data.entertainmentLimitMinutes || 0} 分钟`;
  list.innerHTML = "";
  if (!rows.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "今天还没有娱乐软件或网页记录。";
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

async function loadSummaries() {
  const data = await api("/api/summaries");
  renderSummary($("activeSummaryList"), data.activeRows, "今天还没有活跃使用记录。");
  renderSummary($("runningSummaryList"), data.runningRows, "今天还没有后台运行记录。");
  renderBrowserSummary(data);
}

async function loadConfig() {
  const config = await api("/api/config");
  $("appWhitelist").value = arrayToLines(config.appWhitelist);
  $("runningAppWhitelist").value = arrayToLines(config.runningAppWhitelist);
  $("browserApps").value = arrayToLines(config.browserApps);
  $("browserTitleWhitelist").value = arrayToLines(config.browserTitleWhitelist);
 const entertainmentLimits = config.entertainmentLimits || config.browserEntertainmentLimits || {};
  $("entertainmentWeekdayLimit").value = entertainmentLimits.weekdayMinutes ?? 60;
  $("entertainmentWeekendLimit").value = entertainmentLimits.weekendMinutes ?? 120;
  $("aiEnabled").checked = Boolean(config.aiClassification?.enabled);
  $("aiModel").value = config.aiClassification?.model || "deepseek-v4-flash";
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
  try {
    await api("/api/config", {
      method: "POST",
      body: JSON.stringify({
        appWhitelist: linesToArray($("appWhitelist").value),
        runningAppWhitelist: linesToArray($("runningAppWhitelist").value),
        browserApps: linesToArray($("browserApps").value),
        browserTitleWhitelist: linesToArray($("browserTitleWhitelist").value),
        entertainmentLimits: {
          weekdayMinutes: Number($("entertainmentWeekdayLimit").value || 0),
          weekendMinutes: Number($("entertainmentWeekendLimit").value || 0)
        },
        aiClassification: {
          enabled: $("aiEnabled").checked,
          model: $("aiModel").value.trim() || "deepseek-v4-flash"
        }
      })
    });
    state.configLoaded = false;
    await refreshStatus();
  } catch (error) {
    alert(error.message);
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
$("saveBrowserLimitBtn").addEventListener("click", saveConfig);
$("shutdownBtn").addEventListener("click", shutdown);

refreshStatus().catch((error) => {
  $("statusText").textContent = error.message;
});

setInterval(() => {
  if (state.authed) refreshStatus().catch(() => {});
}, 5000);
