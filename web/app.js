/* 网球俱乐部管理台 —— 原生 JS，无依赖 */
"use strict";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const STATUS_CN = {
  booked: "已预约", checked_out: "已领用", active: "训练中",
  extended: "已续场", closed: "已结单", rain_closed: "雨停结单",
  late_released: "迟到释放", rain_suspended: "雨停挂起",
  available: "可用", in_use: "使用中", maintenance: "维修中",
  charged: "满电", charging: "充电中", open: "待修", repaired: "已修复",
  suspended: "停场",
};

const state = { tab: "calendar", day: null, focus: null };
let CACHE = { state: null, calendar: null };

/* ------------------------------------------------------------------ api */
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || `请求失败 ${res.status}`);
    err.payload = data || {};
    err.status = res.status;
    throw err;
  }
  return data;
}
const post = (p, body) => api(p, { method: "POST", body });

/* ---------------------------------------------------------------- toast */
function toast(msg, kind = "ok", ms = 3200) {
  const div = document.createElement("div");
  div.className = `toast ${kind}`;
  div.textContent = msg;
  $("#toasts").appendChild(div);
  setTimeout(() => div.remove(), ms);
}
async function guard(fn, okMsg) {
  try {
    const out = await fn();
    if (okMsg) toast(okMsg);
    return out;
  } catch (e) {
    toast(e.message, "err", 5000);
    throw e;
  }
}

/* ---------------------------------------------------------------- helpers */
const fen = (n) => `¥${(Number(n || 0) / 100).toFixed(2)}`;
const hm = (isoStr) => isoStr ? isoStr.slice(11, 16) : "";
const pad2 = (n) => String(n).padStart(2, "0");
function localInputValue(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function elapsedFmt(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
}

/* ------------------------------------------------------------------ app */
async function refreshAll() {
  CACHE.state = await api("/api/state").catch(() => CACHE.state);
  renderWeather();
  renderRainBanner();
  await render();
}

/* 后台静默轮询：只更新天气/雨停横幅与缓存；
   日历与设备表这类只读页自动重绘，
   领用/归还/复核等操作页绝不打断清点与表单输入。 */
async function silentRefresh() {
  const prev = CACHE.state;
  CACHE.state = await api("/api/state").catch(() => prev);
  if (!CACHE.state) return;
  renderWeather();
  renderRainBanner();
  if (state.tab === "calendar" || state.tab === "equipment") await render();
}

function renderWeather() {
  const s = CACHE.state;
  if (!s || !s.rain) return;
  const f = s.rain.forecast || {};
  const txt = s.rain.active
    ? `🌧️ ${f.condition || "雨"} ${f.temp_c ?? ""}°C 降水概率 ${f.precip_pct ?? "?"}% · 停场中`
    : `☀️ ${f.condition || ""} ${f.temp_c ?? ""}°C 降水概率 ${f.precip_pct ?? ""}% · 正常营业`;
  $("#weatherChip").textContent = txt;
}

function renderRainBanner() {
  const banner = $("#rainBanner");
  const active = CACHE.state && CACHE.state.rain && CACHE.state.rain.active;
  if (active && !banner.dataset.dismissed) {
    banner.hidden = false;
    const log = CACHE.state.rain.log || {};
    $("#rainBannerText").textContent =
      `🌧️ 雨天停场中：${esc(log.reason || "阵雨")}（${hm(log.started_ts)} 起）。在场上的预约已挂起，雨停后可恢复；过期未领用的将自动释放。`;
  } else {
    banner.hidden = true;
  }
}

$("#rainResumeBtn").onclick = () => guard(async () => {
  const r = await post("/api/rain/resume", {});
  await post("/api/weather", { mode: "sunny" });
  toast(`雨停恢复：${r.restored} 个预约恢复，${r.released} 个过期释放`);
  await refreshAll();
}, "");
$("#rainDismissBtn").onclick = () => {
  $("#rainBanner").dataset.dismissed = "1";
  $("#rainBanner").hidden = true;
};

$("#tabs").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-tab]");
  if (!btn) return;
  state.tab = btn.dataset.tab;
  state.focus = null;
  $$("#tabs button").forEach((b) => b.classList.toggle("active", b === btn));
  render();
});

async function render() {
  const view = $("#view");
  view.innerHTML = '<p class="muted">加载中…</p>';
  const fn = VIEWS[state.tab];
  await fn(view);
}

/* ============================================================== calendar */
const AXIS_START_H = 7, AXIS_END_H = 23; // 07:00 - 23:00
function axisPos(isoStr) {
  const [h, m] = isoStr.slice(11, 16).split(":").map(Number);
  return ((h + m / 60) - AXIS_START_H) / (AXIS_END_H - AXIS_START_H) * 100;
}

async function viewCalendar(view) {
  if (!state.day) state.day = (CACHE.state?.now || localInputValue()).slice(0, 10);
  const data = await api(`/api/calendar?day=${state.day}`);
  CACHE.calendar = data;
  const res = data.reservations;

  const lanes = [
    ...CACHE.state.courts.map((c) => ({ kind: "court", id: c.id, code: c.code, status: c.status })),
    ...CACHE.state.machines.map((m) => ({ kind: "machine", id: m.id, code: m.code, status: m.status })),
  ];

  // 检测同一泳道上的重叠（防御性；正常情况下双重锁定保证不会发生）
  const overlapIds = new Set();
  for (const lane of lanes) {
    const hits = res.filter((r) =>
      (lane.kind === "court" ? r.court_id : r.machine_id) === lane.id &&
      ["booked", "checked_out", "active", "extended", "rain_suspended"].includes(r.status));
    for (let i = 0; i < hits.length; i++)
      for (let j = i + 1; j < hits.length; j++)
        if (hits[i].start_ts < hits[j].end_ts && hits[j].start_ts < hits[i].end_ts)
          overlapIds.add(hits[i].id), overlapIds.add(hits[j].id);
  }

  const ticks = [];
  for (let h = AXIS_START_H; h <= AXIS_END_H; h++)
    ticks.push(`<span class="tick" style="left:${((h - AXIS_START_H) / (AXIS_END_H - AXIS_START_H)) * 100}%">${pad2(h)}:00</span>`);

  const rows = lanes.map((lane) => {
    const blocks = res
      .filter((r) => (lane.kind === "court" ? r.court_id : r.machine_id) === lane.id)
      .map((r) => {
        const left = Math.max(0, axisPos(r.start_ts));
        const right = Math.min(100, axisPos(r.end_ts));
        const cls = ["cal-block", `kind-${lane.kind}`, `status-${r.status}`];
        if (overlapIds.has(r.id)) cls.push("overlap");
        const label = lane.kind === "court"
          ? `${r.code} ${esc(r.member_name)}`
          : `${r.machine_code}→${r.court_code} ${esc(r.member_name)}`;
        return `<div class="${cls.join(" ")}" style="left:${left}%;width:${right - left}%"
                  title="${esc(r.code)} ${hm(r.start_ts)}-${hm(r.end_ts)} ${STATUS_CN[r.status] || r.status}"
                  data-rid="${r.id}">${label}</div>`;
      }).join("");
    return `<div class="cal-row group-${lane.kind}">
        <div class="lane-label">${lane.code}<br><span class="muted" style="font-size:10px">${lane.kind === "court" ? "球场" : "发球机"}${lane.status === "maintenance" || lane.status === "suspended" ? "·" + STATUS_CN[lane.status] : ""}</span></div>
        <div class="lane">${blocks}</div>
      </div>`;
  }).join("");

  const nowIso = CACHE.state.now;
  const nowLine = nowIso.slice(0, 10) === state.day && axisPos(nowIso) > 0 && axisPos(nowIso) < 100
    ? `<div class="now-line" style="left:${axisPos(nowIso)}%"></div>` : "";

  view.innerHTML = `
    <div class="card">
      <div class="row" style="justify-content:space-between">
        <h2 style="margin:0">场地日历 · 球场与发球机共用时间轴</h2>
        <div class="field"><input type="date" id="calDay" value="${state.day}"></div>
      </div>
      <div class="cal-legend">
        <span><span class="sw sw-court"></span>球场上锁（砖红）</span>
        <span><span class="sw sw-machine"></span>发球机上锁（草绿）</span>
        <span><span class="sw sw-now"></span>当前时间</span>
        <span><span class="sw sw-conflict"></span>同泳道冲突（系统双重锁定，正常不会出现）</span>
      </div>
      <div class="cal-wrap">
        <div class="cal-grid">
          <div class="cal-head">
            <div class="cal-corner">资源 / 时间</div>
            <div class="axis" style="position:relative">${ticks.join("")}${nowLine}</div>
          </div>
          ${rows}
        </div>
      </div>
      <p class="muted">同一订单的球场块与机器块在同一横轴位置上下对齐；相邻订单首尾相接不视为冲突（半开区间）。点击色块可跳到该订单。</p>
    </div>`;

  $("#calDay").onchange = (e) => { state.day = e.target.value; render(); };
  $$(".cal-block", view).forEach((el) => el.onclick = () => {
    const rid = Number(el.dataset.rid);
    state.focus = rid;
    state.tab = "sessions";
    $$("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === "sessions"));
    render();
  });
}

/* ================================================================== book */
async function viewBook(view) {
  const s = CACHE.state;
  const startDefault = localInputValue(new Date(Date.now() + 3600_000)).slice(0, 14) + "00";
  const endDefault = localInputValue(new Date(Date.now() + 2 * 3600_000)).slice(0, 14) + "00";
  view.innerHTML = `
    <div class="card">
      <h2>新建预约（确认后同时锁定球场与发球机）</h2>
      <div class="row">
        <div class="field"><label>会员</label>
          <select id="fMember">${s.members.map((m) => `<option value="${m.id}">${esc(m.name)}（${m.level} 级）</option>`).join("")}</select></div>
        <div class="field"><label>开始</label><input type="datetime-local" id="fStart" value="${startDefault}"></div>
        <div class="field"><label>结束</label><input type="datetime-local" id="fEnd" value="${endDefault}"></div>
        <div class="field"><label>押金（元）</label><input type="number" id="fDeposit" value="200" min="0" step="10"></div>
      </div>
      <h3>球场</h3>
      <div class="pill-choice court" id="fCourt">${s.courts.map((c, i) =>
        `<label><input type="radio" name="court" value="${c.id}" ${i === 0 ? "checked" : ""}><span>${c.code} ${c.status === "suspended" ? "（雨停）" : ""}</span></label>`).join("")}</div>
      <h3>发球机</h3>
      <div class="pill-choice" id="fMachine">${s.machines.map((m, i) =>
        `<label><input type="radio" name="machine" value="${m.id}" ${i === 0 ? "checked" : ""}><span>${m.code} ${m.status === "maintenance" ? "（维修中）" : m.status === "in_use" ? "（使用中）" : ""}</span></label>`).join("")}</div>
      <h3>训练模式</h3>
      <div class="pill-choice" id="fMode">${s.training_modes.map((t, i) =>
        `<label><input type="radio" name="mode" value="${esc(t)}" ${i === 0 ? "checked" : ""}><span>${t}</span></label>`).join("")}</div>
      <div style="margin-top:16px"><button class="btn" id="bookBtn">确认预约 · 双重锁定</button></div>
      <div id="bookErr"></div>
    </div>`;
  $("#bookBtn").onclick = () => guard(async () => {
    const body = {
      member_id: Number($("#fMember").value),
      court_id: Number($('input[name=court]:checked', view).value),
      machine_id: Number($('input[name=machine]:checked', view).value),
      start: $("#fStart").value, end: $("#fEnd").value,
      training_mode: $('input[name=mode]:checked', view).value,
      deposit: Math.round(Number($("#fDeposit").value) * 100),
    };
    $("#bookErr").innerHTML = "";
    try {
      const r = await post("/api/reservations", body);
      toast(`预约成功 ${r.code}：球场与发球机已同时锁定`);
      state.focus = r.id; state.tab = "sessions";
      $$("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === "sessions"));
      await refreshAll();
    } catch (e) {
      const res = e.payload || {};
      const tag = res.resource === "court" ? "⛔ 球场冲突" : res.resource === "machine" ? "⛔ 发球机冲突"
        : res.resource === "battery" ? "🔋 电池不可用" : res.resource === "basket" ? "🧺 球筐不可用" : "⚠️ 无法预约";
      $("#bookErr").innerHTML = `<div class="inline-err"><b>${tag}：</b>${esc(e.message)}</div>`;
      throw e;
    }
  }, "");
}

/* ============================================================== equipment */
async function viewEquipment(view) {
  const s = CACHE.state;
  const photoOf = (type, id) => {
    const p = (CACHE.state.photos || []); // photos not cached globally; skip heavy
    return null;
  };
  view.innerHTML = `
    <div class="card grass">
      <h2>设备可用表</h2>
      <div class="row" style="margin-bottom:10px">
        <button class="btn small grass" id="wxSun">☀️ 模拟天晴</button>
        <button class="btn small" id="wxRain">🌧️ 模拟下雨并停场</button>
        <span class="muted">天气适配器为模拟返回；后台每 5 秒巡检一次，也会自动停场/恢复。</span>
      </div>
      <table class="tbl">
        <thead><tr><th>发球机</th><th>型号</th><th>状态</th><th>未决故障</th></tr></thead>
        <tbody>${s.machines.map((m) => `<tr>
          <td><b>${m.code}</b></td><td>${esc(m.model)}</td>
          <td><span class="badge ${m.status}">${STATUS_CN[m.status]}</span></td>
          <td>${m.open_fault ? esc(m.open_fault.description) : "—"}</td></tr>`).join("")}</tbody>
      </table>
    </div>
    <div class="card">
      <h2>电池</h2>
      <table class="tbl">
        <thead><tr><th>编号</th><th>状态</th><th>距充满</th></tr></thead>
        <tbody>${s.batteries.map((b) => `<tr>
          <td><b>${b.code}</b></td>
          <td><span class="badge ${b.status}">${STATUS_CN[b.status]}</span></td>
          <td>${b.status === "charging" ? `约 ${b.charge_remaining_min} 分钟（未完成不可分配）` : "—"}</td></tr>`).join("")}</tbody>
      </table>
    </div>
    <div class="card grass">
      <h2>球筐</h2>
      <table class="tbl">
        <thead><tr><th>编号</th><th>容量</th><th>状态</th></tr></thead>
        <tbody>${s.baskets.map((b) => `<tr>
          <td><b>${b.code}</b></td><td>${b.capacity} 颗</td>
          <td><span class="badge ${b.status === "available" ? "available" : "in_use"}">${STATUS_CN[b.status]}</span></td></tr>`).join("")}</tbody>
      </table>
    </div>
    <div class="card">
      <h2>球场</h2>
      <table class="tbl">
        <thead><tr><th>编号</th><th>地面</th><th>状态</th></tr></thead>
        <tbody>${s.courts.map((c) => `<tr><td><b>${c.code}</b></td><td>${esc(c.surface)}</td>
          <td><span class="badge ${c.status === "open" ? "available" : "suspended"}">${c.status === "open" ? "开放" : "雨停"}</span></td></tr>`).join("")}</tbody>
      </table>
    </div>`;
  $("#wxSun").onclick = () => guard(async () => {
    await post("/api/weather", { mode: "sunny" });
    await refreshAll(); toast("天气适配器：晴");
  }, "");
  $("#wxRain").onclick = () => guard(async () => {
    await post("/api/weather", { mode: "rain" });
    await post("/api/rain/suspend", { reason: "前台手动：雨势加大，临时停场" });
    await refreshAll(); toast("已停场");
  }, "");
}

/* ============================================================== sessions */
let timerHandle = null;
async function viewSessions(view) {
  if (timerHandle) { clearInterval(timerHandle); timerHandle = null; }
  const open = await api("/api/sessions/open");
  const sessions = open.sessions;

  if (state.focus) {
    const detail = await api(`/api/session/${state.focus}`);
    view.innerHTML = sessionDetailHtml(detail);
    wireSessionDetail(view, detail);
    return;
  }

  view.innerHTML = `
    <div class="card">
      <h2>进行中的预约（${sessions.length}）</h2>
      ${sessions.length === 0 ? '<p class="muted">当前没有进行中或待领用的预约。</p>' : ""}
      <table class="tbl">
        <thead><tr><th>订单</th><th>会员</th><th>场地/机器</th><th>时段</th><th>状态</th><th></th></tr></thead>
        <tbody>${sessions.map((r) => `<tr>
          <td class="code-mono">${r.code}</td><td>${esc(r.member_name)}</td>
          <td>${r.court_code} + ${r.machine_code}</td>
          <td>${hm(r.start_ts)}–${hm(r.end_ts)}</td>
          <td><span class="badge ${r.status}">${STATUS_CN[r.status]}</span></td>
          <td><button class="btn small" data-id="${r.id}">处理</button></td></tr>`).join("")}</tbody>
      </table>
    </div>`;
  $$("button[data-id]", view).forEach((b) => b.onclick = () => {
    state.focus = Number(b.dataset.id); render();
  });
}

function bigStepper(id, value, min, max, step = 1, fiveStep = 5) {
  return `<div class="stepper" id="${id}" data-min="${min}" data-max="${max}">
      <button type="button" data-d="-${fiveStep}">−${fiveStep}</button>
      <button type="button" data-d="-${step}">−</button>
      <span class="num">${value}</span>
      <button type="button" data-d="${step}">+</button>
      <button type="button" data-d="${fiveStep}">+${fiveStep}</button>
    </div>`;
}
function wireStepper(el, onChange) {
  const num = $(".num", el);
  el.querySelectorAll("button").forEach((b) => b.onclick = () => {
    const min = Number(el.dataset.min), max = Number(el.dataset.max);
    let v = Number(num.textContent) + Number(b.dataset.d);
    v = Math.min(max, Math.max(min, v));
    num.textContent = v;
    num.classList.toggle("short", v < min);
    onChange(v);
  });
}

function sessionDetailHtml(r) {
  const canCheckout = r.status === "booked";
  const canStart = r.status === "checked_out";
  const canReturn = ["checked_out", "active", "extended", "rain_suspended"].includes(r.status);
  const chargedBatteries = CACHE.state.batteries.filter((b) => b.status === "charged");
  const freeBaskets = CACHE.state.baskets.filter((b) => b.status === "available");

  return `
  <p><button class="btn small ghost" id="backList">← 返回列表</button></p>
  <div class="session-grid">
    <div>
      <div class="card">
        <h2>${r.code} <span class="badge ${r.status}">${STATUS_CN[r.status]}</span></h2>
        <dl class="kv">
          <dt>会员</dt><dd>${esc(r.member_name)}（${r.member_level} 级）</dd>
          <dt>资源</dt><dd>球场 ${r.court_code} ＋ 发球机 ${r.machine_code}</dd>
          <dt>时段</dt><dd>${r.start_ts.slice(5, 16).replace("T", " ")} – ${hm(r.end_ts)}</dd>
          <dt>模式</dt><dd>${esc(r.training_mode)}</dd>
          <dt>押金</dt><dd>${fen(r.deposit)}</dd>
          ${r.note ? `<dt>备注</dt><dd>${esc(r.note)}</dd>` : ""}
        </dl>
        <div class="timer-box" id="timerBox" style="margin-top:12px">
          <div class="muted">训练计时（自领用起）</div>
          <div class="timer-big" id="timerBig">--:--:--</div>
          <div class="timer-sub" id="timerSub">尚未领用</div>
        </div>
        <div id="actBar" style="margin-top:12px; display:flex; gap:8px; flex-wrap:wrap">
          ${canStart ? `<button class="btn grass" id="startBtn">▶ 开始训练</button>` : ""}
          ${canReturn ? `<button class="btn" id="extendBtn">⏱ 临时续场</button>
            <button class="btn grass" id="goReturn">🧺 归还清点</button>` : ""}
        </div>
      </div>

      ${canCheckout ? `
      <div class="card grass" id="checkoutCard">
        <h2>领用清单（开场前）</h2>
        <ul class="checklist">
          <li><span class="mark">①</span> 预约状态为「已预约」，球场+机器已锁定</li>
          <li><span class="mark">②</span> 选择满电电池（充电中的电池不可选）</li>
          <li><span class="mark">③</span> 选择空闲球筐，记录发出的散球数量</li>
        </ul>
        <div class="row">
          <div class="field"><label>电池</label>
            <select id="coBattery">${chargedBatteries.length
              ? chargedBatteries.map((b) => `<option value="${b.id}">${b.code}（满电）</option>`).join("")
              : '<option value="">暂无满电电池</option>'}</select></div>
          <div class="field"><label>球筐</label>
            <select id="coBasket">${freeBaskets.length
              ? freeBaskets.map((b) => `<option value="${b.id}">${b.code}（容量 ${b.capacity}）</option>`).join("")
              : '<option value="">暂无空闲球筐</option>'}</select></div>
          <div class="field"><label>经办人</label><input id="coChecker" value="前台-王敏"></div>
        </div>
        <h3>发出散球数量</h3>
        ${bigStepper("coStepper", 60, 1, 60, 1, 10)}
        <div style="margin-top:10px"><button class="btn grass" id="checkoutBtn">确认领用 · 电池/球筐/机器同时置占用</button></div>
        <div id="coErr"></div>
      </div>` : ""}

      ${r.checkout_ts ? `
      <div class="card">
        <h2>领用记录</h2>
        <dl class="kv">
          <dt>电池</dt><dd>${esc(r.battery_code)}${r.swaps && r.swaps.length ? ` → ${esc(r.current_battery_code)}（已换 ${r.swaps.length} 次）` : ""}</dd>
          <dt>球筐</dt><dd>${esc(r.basket_code)}</dd>
          <dt>发球</dt><dd>${r.balls_issued} 颗</dd>
          <dt>领用时间</dt><dd>${hm(r.checkout_ts)}</dd>
        </dl>
        ${canReturn ? `
        <hr class="divider">
        <h3>训练中电池掉电？换一块满电电池（旧电池立即送去充电）</h3>
        <div class="row">
          <div class="field"><label>换上的满电电池</label>
            <select id="swapBattery">${chargedBatteries.filter((b) => b.id !== r.current_battery_id)
              .map((b) => `<option value="${b.id}">${b.code}（满电）</option>`).join("") || "<option>无其他满电电池</option>"}</select></div>
          <button class="btn small" id="swapBtn" ${chargedBatteries.filter((b) => b.id !== r.current_battery_id).length ? "" : "disabled"}>🔋 登记掉电并换电</button>
        </div>` : ""}
        ${r.swaps && r.swaps.length ? `<p class="muted">换电历史：${r.swaps.map((s) => `${hm(s.swap_ts)} ${s.old_code}→${s.new_code}（${esc(s.reason)}）`).join("；")}</p>` : ""}
      </div>` : ""}

      ${r.balls_returned != null ? `
      <div class="card ${r.balls_short > 0 ? "" : "grass"}">
        <h2>归还清点结果</h2>
        <dl class="kv">
          <dt>归还散球</dt><dd>${r.balls_returned} 颗</dd>
          <dt>短缺</dt><dd style="color:${r.balls_short ? "var(--danger)" : "inherit"}">${r.balls_short} 颗${r.balls_short ? `（赔偿 ${fen(r.balls_short * 800)}，待经理复核）` : " ✅"}</dd>
          <dt>卡球</dt><dd>${r.jammed ? "是，机器已转维修" : "否"}</dd>
          <dt>刮伤</dt><dd>${r.scratch ? fen(r.scratch) : "无"}</dd>
          <dt>归还时间</dt><dd>${hm(r.return_ts)} · ${esc(r.inspector || "")}</dd>
          ${r.return_note ? `<dt>备注</dt><dd>${esc(r.return_note)}</dd>` : ""}
        </dl>
        ${r.review ? `<hr class="divider"><b>押金已复核：</b>扣除 ${fen(r.review.total_deducted)}，退还 ${fen(r.review.refunded)}（流水 ${esc(r.review.payment_txn || "—")}，经办 ${esc(r.review.manager)}）` : ""}
      </div>` : ""}
    </div>

    <div>
      <div class="card grass">
        <h2>结单条件</h2>
        <ul class="checklist">
          <li><span class="mark ${r.machine_id ? "ok-mark" : "no-mark"}">${["closed", "rain_closed"].includes(r.status) ? "✓" : "○"}</span> 发球机已归还${r.jammed ? "（卡球 → 转维修）" : ""}</li>
          <li><span class="mark">${["closed", "rain_closed"].includes(r.status) ? "✓" : "○"}</span> 球筐已回收并置为可用</li>
          <li><span class="mark">${["closed", "rain_closed"].includes(r.status) ? "✓" : "○"}</span> 散球清点完成${r.balls_returned != null ? `（差 ${r.balls_short}）` : ""}</li>
          <li><span class="mark">${["closed", "rain_closed"].includes(r.status) ? "✓" : "○"}</span> 电池已上架充电（未充满前不可再分配）</li>
        </ul>
      </div>
      ${r.photos && r.photos.length ? `<div class="card"><h2>设备照片</h2><div class="photos-row">${r.photos.map((p) => `<img class="photo-thumb" src="/photos/${esc(p.path)}" alt="${esc(p.label)}">`).join("")}</div></div>` : ""}
    </div>
  </div>`;
}

function wireSessionDetail(view, r0) {
  $("#backList").onclick = () => { state.focus = null; render(); };

  if (r0.checkout_ts) {
    const checkoutTs = new Date(r0.checkout_ts);
    const endTs = new Date(r0.end_ts);
    const tick = () => {
      const now = new Date();
      const el = $("#timerBig"), sub = $("#timerSub"), box = $("#timerBox");
      if (!el) { clearInterval(timerHandle); return; }
      el.textContent = elapsedFmt((now - checkoutTs) / 1000);
      const left = (endTs - now) / 1000;
      box.classList.toggle("over", left < 0);
      sub.textContent = left >= 0
        ? `距计划结束还有 ${elapsedFmt(left)}`
        : `已超时 ${elapsedFmt(-left)}，请提醒客人续场或归还`;
    };
    tick();
    timerHandle = setInterval(tick, 1000);
  }

  if (r.status === "booked") {
    const st = $(".stepper", $("#checkoutCard"));
    wireStepper(st, () => {});
    $("#checkoutBtn").onclick = () => guard(async () => {
      const body = {
        battery_id: Number($("#coBattery").value),
        basket_id: Number($("#coBasket").value),
        balls_issued: Number($("#coStepper .num").textContent),
        checker: $("#coChecker").value,
      };
      if (!body.battery_id || !body.basket_id) {
        $("#coErr").innerHTML = '<div class="inline-err">没有可用的满电电池或空闲球筐</div>';
        return;
      }
      try {
        const r = await post(`/api/reservations/${state.focus}/checkout`, body);
        toast(`领用完成：${r.basket_code} + ${r.current_battery_code}，机器置为使用中`);
        await refreshAll();
      } catch (e) {
        $("#coErr").innerHTML = `<div class="inline-err">${esc(e.message)}</div>`;
        throw e;
      }
    }, "");
  }

  const startBtn = $("#startBtn");
  if (startBtn) startBtn.onclick = () => guard(async () => {
    await post(`/api/reservations/${state.focus}/start`, {});
    await refreshAll(); toast("训练开始，计时启动");
  }, "");

  const extBtn = $("#extendBtn");
  if (extBtn) extBtn.onclick = () => guard(async () => {
    const mins = Number(prompt("临时续场多少分钟？（系统会重新检查球场与发球机的后续预约）", "30"));
    if (!mins) return;
    try {
      await post(`/api/reservations/${state.focus}/extend`, { minutes: mins });
      await refreshAll(); toast(`已续场 ${mins} 分钟`);
    } catch (e) {
      toast(`续场被拒：${e.message}`, "err", 5000);
      throw e;
    }
  }, "");

  const goReturn = $("#goReturn");
  if (goReturn) goReturn.onclick = () => {
    state.tab = "returns";
    $$("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === "returns"));
    render();
  };

  const swapBtn = $("#swapBtn");
  if (swapBtn) swapBtn.onclick = () => guard(async () => {
    const id = Number($("#swapBattery").value);
    if (!id) return;
    await post(`/api/reservations/${state.focus}/swap-battery`, { battery_id: id, reason: "掉电" });
    await refreshAll(); toast("已换电，旧电池开始充电 45 分钟");
  }, "");
}

/* =============================================================== returns */
async function viewReturns(view) {
  view.classList.add("return-page");
  const open = await api("/api/sessions/open");
  const due = open.sessions.filter((r) =>
    ["checked_out", "active", "extended", "rain_suspended"].includes(r.status));

  if (!state.focus || !due.some((r) => r.id === state.focus)) {
    if (!state.focus && due.length) state.focus = due[0].id;
  }
  if (!state.focus || !due.some((r) => r.id === state.focus)) {
    view.innerHTML = `<div class="card"><h2>球筐回收</h2>
      <p class="muted">当前没有待归还的训练订单。雨停挂起的订单也可以在此直接清点结单。</p></div>`;
    return;
  }

  const r = await api(`/api/session/${state.focus}`);
  const issued = r.balls_issued ?? 0;

  view.innerHTML = `
    <div class="card">
      <div class="row" style="justify-content:space-between">
        <h2 style="margin:0">球筐回收 · 归还清点</h2>
        <select id="retPick">${due.map((d) => `<option value="${d.id}" ${d.id === r.id ? "selected" : ""}>${d.code} · ${esc(d.member_name)} · ${d.court_code}+${d.machine_code}</option>`).join("")}</select>
      </div>
      <dl class="kv" style="margin-top:10px">
        <dt>球筐/电池</dt><dd>${esc(r.basket_code)} ＋ 当前电池 ${esc(r.current_battery_code)}（归还后立即充电）</dd>
        <dt>发出散球</dt><dd>${issued} 颗</dd>
      </dl>
    </div>

    <div class="card grass">
      <h2>实际收回散球（大数字步进清点）</h2>
      ${bigStepper("retStepper", issued, 0, issued + 30, 1, 5)}
      <div class="diff-line" id="retDiff"></div>
      <div class="row">
        <label class="field" style="flex-direction:row;align-items:center;gap:8px">
          <input type="checkbox" id="retJammed" style="width:18px;height:18px"> 卡球（机器转维修，不可再分配）</label>
        <label class="field" style="flex-direction:row;align-items:center;gap:8px">
          <input type="checkbox" id="retSwapped" style="width:18px;height:18px" ${r.swaps && r.swaps.length ? "checked" : ""}> 训练中曾掉电换电</label>
      </div>
      <div class="row" style="margin-top:10px">
        <div class="field"><label>设备刮伤赔偿（元，0 为无）</label>
          <input type="number" id="retScratch" value="0" min="0" step="5" style="width:160px"></div>
        <div class="field" style="flex:1;min-width:200px"><label>清点备注</label>
          <input id="retNote" placeholder="如：2 颗打入隔壁场地待找"></div>
        <div class="field"><label>清点人</label><input id="retInspector" value="前台-王敏"></div>
      </div>
      <div class="fee-preview" id="retFee">
        球数短缺赔偿：<span class="big" id="retFeeNum">¥0.00</span>
        <span class="muted">（每颗 ¥8.00，最终扣款由经理在「押金复核」中确认）</span>
      </div>
      <button class="btn grass" id="retSubmit">✅ 清点无误（或登记短缺）· 归还结单</button>
      <div id="retErr" style="margin-top:8px"></div>
      <p class="muted" style="margin-top:8px">结单即：球筐置可用、发球机归还（卡球则转维修）、电池进入充电（45 分钟内不可分配）。</p>
    </div>`;

  $("#retPick").onchange = (e) => { state.focus = Number(e.target.value); render(); };

  const numEl = $("#retStepper .num");
  const update = (v) => {
    const short = Math.max(0, issued - v);
    const diff = $("#retDiff");
    numEl.classList.remove("short", "ok");
    if (short > 0) {
      numEl.classList.add("short");
      diff.innerHTML = `短缺 <span class="short">${short} 颗</span> · 赔偿 ${fen(short * 800)}（需经理确认扣款）`;
    } else {
      numEl.classList.add("ok");
      diff.innerHTML = `<span class="ok">数量一致或多收，清点通过 ✓</span>`;
    }
    $("#retFeeNum").textContent = fen(short * 800);
  };
  wireStepper($("#retStepper"), update);
  update(Number(numEl.textContent));

  $("#retSubmit").onclick = () => guard(async () => {
    const body = {
      balls_returned: Number(numEl.textContent),
      jammed: $("#retJammed").checked,
      battery_replaced: $("#retSwapped").checked,
      scratch_fen: Math.round(Number($("#retScratch").value || 0) * 100),
      note: $("#retNote").value, inspector: $("#retInspector").value,
    };
    try {
      const out = await post(`/api/reservations/${state.focus}/return`, body);
      toast(`已结单：短缺 ${out.balls_short} 颗，电池已开始充电`);
      state.focus = null;
      state.tab = "deposits";
      $$("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === "deposits"));
      await refreshAll();
    } catch (e) {
      $("#retErr").innerHTML = `<div class="inline-err">${esc(e.message)}</div>`;
      throw e;
    }
  }, "");
}

/* ================================================================ faults */
async function viewFaults(view) {
  const data = await api("/api/faults?open=1");
  const all = await api("/api/faults");
  view.innerHTML = `
    <div class="card">
      <h2>故障登记与维修</h2>
      <div class="row">
        <div class="field"><label>发球机</label>
          <select id="fFltMachine">${CACHE.state.machines.map((m) => `<option value="${m.id}">${m.code}</option>`).join("")}</select></div>
        <div class="field"><label>类型</label>
          <select id="fFltKind">
            <option value="jam">卡球</option><option value="poweroff">掉电/供电</option>
            <option value="scratch">设备刮伤</option><option value="other">其他</option>
          </select></div>
        <div class="field" style="flex:1;min-width:220px"><label>描述</label>
          <input id="fFltDesc" placeholder="如：第 3 发球轮异响"></div>
        <button class="btn" id="fltAdd">登记故障（机器转维修）</button>
      </div>
      <div id="fltErr"></div>
    </div>
    <div class="card grass">
      <h2>待修（${data.faults.length}）· 维修中的机器不可分配</h2>
      ${data.faults.length === 0 ? '<p class="muted">没有待修故障。</p>' : `
      <table class="tbl"><thead><tr><th>机器</th><th>类型</th><th>描述</th><th>关联订单</th><th>报修时间</th><th></th></tr></thead>
      <tbody>${data.faults.map((f) => `<tr>
        <td><b>${f.machine_code}</b></td><td>${({ jam: "卡球", poweroff: "掉电", scratch: "刮伤", other: "其他" })[f.kind]}</td>
        <td>${esc(f.description)}</td><td class="code-mono">${esc(f.reservation_code || "—")}</td>
        <td>${hm(f.reported_ts)}</td>
        <td><button class="btn small grass" data-fid="${f.id}">修复完成</button></td></tr>`).join("")}</tbody></table>`}
    </div>
    <div class="card">
      <h2>维修历史</h2>
      <table class="tbl"><thead><tr><th>机器</th><th>类型</th><th>描述</th><th>处理</th><th>时间</th></tr></thead>
      <tbody>${all.faults.filter((f) => f.status === "repaired").map((f) => `<tr>
        <td><b>${f.machine_code}</b></td><td>${f.kind}</td><td>${esc(f.description)}</td>
        <td>${esc(f.resolution || "")}</td><td>${hm(f.resolved_ts)}</td></tr>`).join("") || '<tr><td colspan="5" class="muted">暂无</td></tr>'}</tbody></table>
    </div>`;
  $("#fltAdd").onclick = () => guard(async () => {
    try {
      await post("/api/faults", {
        machine_id: Number($("#fFltMachine").value),
        kind: $("#fFltKind").value, desc: undefined,
        description: $("#fFltDesc").value || "前台登记故障",
      });
      await refreshAll(); toast("故障已登记，机器转为维修中");
    } catch (e) {
      $("#fltErr").innerHTML = `<div class="inline-err">${esc(e.message)}</div>`;
      throw e;
    }
  }, "");
  $$("button[data-fid]", view).forEach((b) => b.onclick = () => guard(async () => {
    const res = prompt("维修处理说明", "已清理出球通道并试机正常") || "已修复";
    await post(`/api/faults/${b.dataset.fid}/repair`, { resolution: res, mechanic: "机修-李工" });
    await refreshAll(); toast("维修完成，机器恢复可分配");
  }, ""));
}

/* ============================================================== deposits */
async function viewDeposits(view) {
  const pending = await api("/api/deposits/pending");
  const done = await api("/api/deposits");
  view.innerHTML = `
    <div class="card">
      <h2>押金复核（仅经理可依据归还记录确认扣款）</h2>
      <div class="row">
        <div class="field"><label>当前操作角色</label>
          <select id="dpRole"><option value="clerk">前台（只能预览）</option><option value="manager" selected>经理</option></select></div>
        <div class="field"><label>经理签名</label><input id="dpManager" value="经理-赵磊"></div>
      </div>
    </div>
    <div class="card grass">
      <h2>待复核（${pending.reviews.length}）</h2>
      ${pending.reviews.length === 0 ? '<p class="muted">全部处理完毕。</p>' : ""}
      ${pending.reviews.map((r) => `
        <div style="border:1.5px solid #d8cbb6;border-radius:10px;padding:12px;margin-bottom:12px" data-rid="${r.id}">
          <div class="row" style="justify-content:space-between">
            <div><b>${r.code}</b> · ${esc(r.member_name)} · ${r.court_code}+${r.machine_code}
              <span class="muted">归还于 ${hm(r.return_ts)}</span></div>
            <div>押金 <b>${fen(r.deposit)}</b> · 领用 ${r.balls_issued} 归还 ${r.balls_returned}
              · 短缺 <b style="color:${r.balls_short ? "var(--danger)" : "inherit"}">${r.balls_short}</b> 颗
              ${r.scratch ? ` · 刮伤建议赔偿 ${fen(r.scratch)}` : ""}</div>
          </div>
          ${r.return_note ? `<p class="muted" style="margin:6px 0">归还备注：${esc(r.return_note)}</p>` : ""}
          <div class="fee-preview" id="prev-${r.id}">清点记录读取中…</div>
          <div class="row">
            <button class="btn small ghost" data-act="preview" data-rid="${r.id}">按归还记录试算</button>
            <button class="btn small" data-act="confirm" data-rid="${r.id}">经理确认扣款（幂等）</button>
            <span class="muted">重复点击不会重复扣款：同一订单只能确认一次，再次确认返回原流水。</span>
          </div>
        </div>`).join("")}
    </div>
    <div class="card">
      <h2>已确认记录</h2>
      <table class="tbl"><thead><tr><th>订单</th><th>会员</th><th>球损</th><th>刮伤</th><th>其他</th><th>扣款合计</th><th>退还</th><th>流水</th><th>经理</th></tr></thead>
      <tbody>${done.reviews.map((d) => `<tr>
        <td class="code-mono">${esc(d.reservation_code)}</td><td>${esc(d.member_name)}</td>
        <td>${fen(d.balls_fee)}</td><td>${fen(d.scratch_fee)}</td><td>${fen(d.other_fee)}</td>
        <td><b>${fen(d.total_deducted)}</b></td><td>${fen(d.refunded)}</td>
        <td class="code-mono">${esc(d.payment_txn || "—")}</td><td>${esc(d.manager)}</td></tr>`).join("")
        || '<tr><td colspan="9" class="muted">暂无</td></tr>'}</tbody></table>
    </div>`;

  $$("button[data-act]", view).forEach((b) => b.onclick = () => guard(async () => {
    const rid = Number(b.dataset.rid);
    const role = $("#dpRole").value;
    const body = { role, manager: $("#dpManager").value, confirm: b.dataset.act === "confirm" };
    try {
      const out = await post(`/api/deposits/${rid}/review`, body);
      if (out.preview) {
        $(`#prev-${rid}`).innerHTML =
          `试算：球损 ${fen(out.balls_fee)} ＋ 刮伤 ${fen(out.scratch_fee)} ＋ 其他 ${fen(out.other_fee)}
           = 扣款 <span class="big">${fen(out.total_deducted)}</span>，应退 <b>${fen(out.refunded)}</b>`;
        toast("已按归还记录试算（未扣款）", "info");
      } else {
        toast(out.idempotent ? `该订单已复核过，幂等返回原流水 ${out.payment_txn}` : `扣款已确认，流水 ${out.payment_txn || "—"}`);
        await refreshAll();
      }
    } catch (e) {
      toast(e.status === 403 ? `权限拒绝：${e.message}` : e.message, "err", 5000);
      $(`#prev-${rid}`).innerHTML = `<span style="color:var(--danger)">${esc(e.message)}</span>`;
      throw e;
    }
  }, ""));
}

const VIEWS = {
  calendar: viewCalendar, book: viewBook, equipment: viewEquipment,
  sessions: viewSessions, returns: viewReturns, faults: viewFaults,
  deposits: viewDeposits,
};

/* ----------------------------------------------------------------- boot */
async function boot() {
  await refreshAll();
  setInterval(silentRefresh, 6000);
}
boot();
