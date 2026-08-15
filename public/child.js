const $ = (id) => document.getElementById(id);

function formatMs(ms) {
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 60) return `${minutes} 分钟`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} 小时 ${m} 分钟` : `${h} 小时`;
}

function categoryToChinese(category) {
  const map = {
    entertainment: "娱乐",
    social: "社交",
    work: "工作",
    study: "学习",
    shopping: "购物",
    news: "新闻",
    tool: "工具",
    unknown: "未知"
  };
  return map[category] || category || "未知";
}

let liveTab = "active_counted";

const liveStatusLabels = {
  active_counted: "正在使用 · 计入总时长",
  active_excluded: "正在使用 · 不计入总时长",
  background: "处于后台 · 不计时",
  minimized: "已最小化 · 不计时",
  covered: "被遮挡 · 不计时",
  unavailable: "暂未采样"
};

function renderLiveRows(rows) {
  const list = $("liveWindowList");
  list.replaceChildren();
  if (!rows.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = `当前没有${liveStatusLabels[liveTab] || "该状态"}的窗口。`;
    list.appendChild(empty);
    return;
  }

  for (const row of rows) {
    const item = document.createElement("article");
    item.className = `liveRow status-${row.status || "unavailable"}`;

    const dot = document.createElement("span");
    dot.className = "liveDot";
    dot.setAttribute("aria-hidden", "true");

    const content = document.createElement("div");
    content.className = "liveContent";

    const name = document.createElement("strong");
    name.className = "liveName";
    name.textContent = row.name || row.exe || "未知应用";

    const title = document.createElement("span");
    title.className = "liveTitle";
    title.textContent = row.title || row.url || "无标题";

    const meta = document.createElement("span");
    meta.className = "liveMeta";
    const category = categoryToChinese(row.category);
    const visibility = row.visibilityLabel || (row.visiblePercent > 0 ? `可见 ${row.visiblePercent}%` : "不可见");
    meta.textContent = `${category} · ${visibility}`;

    content.append(name, title, meta);

    const state = document.createElement("div");
    state.className = "liveState";

    const stateLabel = document.createElement("strong");
    stateLabel.textContent = row.statusLabel || (row.timing ? "计时中" : "未计时");

    const reason = document.createElement("span");
    reason.textContent = row.reason || "";

    state.append(stateLabel, reason);
    item.append(dot, content, state);
    list.appendChild(item);
  }
}

function renderLiveWindows(data) {
  const live = data.liveWindows || {};
  const groups = live.groups || {};
  for (const status of Object.keys(liveStatusLabels)) {
    const count = (groups[status] || []).length;
    const suffix = status.split("_").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("");
    const countElement = $(`liveCount${suffix}`);
    if (countElement) countElement.textContent = String(count);
    const tab = document.querySelector(`[data-live-tab="${status}"]`);
    const labelNode = tab && Array.from(tab.childNodes).find((node) => node.nodeType === Node.TEXT_NODE);
    if (labelNode) labelNode.textContent = ` ${liveStatusLabels[status]} `;
  }
  $("liveUpdatedText").textContent = live.stale ? "采样暂不可用" : "实时更新";
  renderLiveRows(groups[liveTab] || []);
}

async function api(path) {
  const res = await fetch(path, { credentials: "same-origin" });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "请求失败");
  return data;
}

function renderEntertainmentRows(rows) {
  const list = $("childBrowserList");
  list.innerHTML = "";
  if (!rows.length) {
    list.innerHTML = '<p class="empty">今天还没有娱乐软件或网页记录。</p>';
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

async function refreshChild() {
  const data = await api("/api/child-summary");
  const usedMs = Math.max(0, Number(data.entertainmentTotalMs || 0));
  const limitMs = Math.max(0, Number(data.entertainmentLimitMs || 0));
  const remainingMs = limitMs > 0 ? Math.max(0, limitMs - usedMs) : 0;
  const usagePercent = limitMs > 0 ? Math.min(100, (usedMs / limitMs) * 100) : 0;
  const remainingPercent = limitMs > 0 ? Math.max(0, 100 - usagePercent) : 0;
  const usageBar = $("childUsageBar").firstElementChild;
  $("childStatus").textContent = data.monitoring ? "今日限制正在生效" : "监控服务未完全运行";
  $("remainingValue").textContent = formatMs(remainingMs);
  $("remainingRatio").textContent = limitMs > 0 ? `剩余 ${Math.round(remainingPercent)}%` : "未设置总额度";
  $("childUsedLabel").textContent = `已用 ${formatMs(usedMs)}`;
  $("childLimitLabel").textContent = limitMs > 0 ? `总额度 ${formatMs(limitMs)}` : "总额度未设置";
  const dayLabel = data.dayLabel || (data.dayType === "weekend" ? "休息日" : "工作日");
  $("childDayType").textContent = data.dayReason
    ? `${dayLabel}（${data.dayReason}）`
    : dayLabel;
  $("childUsageBar").setAttribute("aria-valuenow", String(Math.round(usagePercent)));
  usageBar.style.width = `${usagePercent}%`;
  usageBar.classList.toggle("nearLimit", usagePercent >= 75 && usagePercent < 100);
  usageBar.classList.toggle("exhausted", usagePercent >= 100);
  $("remainingHint").textContent = limitMs > 0
    ? `软件和网页已使用 ${formatMs(usedMs)}，上限 ${formatMs(limitMs)}。`
    : "今天没有设置娱乐总额度。";
  $("browserLimitText").textContent = limitMs > 0 ? `${formatMs(usedMs)} / ${formatMs(limitMs)}` : "未设置总额度";
  renderLiveWindows(data);
  renderEntertainmentRows(data.entertainmentRows || []);
}

$("childRefreshBtn").addEventListener("click", refreshChild);
document.querySelectorAll("[data-live-tab]").forEach((button) => {
  button.addEventListener("click", () => {
    liveTab = button.dataset.liveTab || "active_counted";
    document.querySelectorAll("[data-live-tab]").forEach((tab) => {
      const selected = tab === button;
      tab.classList.toggle("active", selected);
      tab.setAttribute("aria-selected", String(selected));
    });
    refreshChild().catch(() => {});
  });
});
refreshChild().catch((error) => {
  $("childStatus").textContent = error.message;
});
setInterval(() => refreshChild().catch(() => {}), 5000);
