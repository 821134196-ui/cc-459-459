'use strict';

// ================= 全局状态与工具 =================
let STATE = null;
let timerTick = null;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function api(path, opts = {}) {
  return fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  }).then(async (r) => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(data.message || '请求失败'), { code: data.error, info: data.info });
    return data.data;
  });
}

function toast(msg, kind = 'ok') {
  const box = $('#toast');
  const el = document.createElement('div');
  el.className = `toast-item ${kind}`;
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 300); }, 2600);
}

function pad(n) { return String(n).padStart(2, '0'); }
function hm(ms) { if (!ms) return '—'; const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function mdhm(ms) { if (!ms) return '—'; const d = new Date(ms); return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function dtLocal(ms) { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function yuan(n) { return `¥${Number(n || 0)}`; }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

const STATUS_LABEL = {
  confirmed: '待领用', issued: '进行中', returned: '已归还待结单', rain_stopped: '雨停待结单',
  settled: '已结单', released: '迟到释放', cancelled: '已取消',
};

// ================= 标签页 =================
$$('#tabs button').forEach((b) => b.addEventListener('click', () => {
  $$('#tabs button').forEach((x) => x.classList.remove('active'));
  $$('.tabpane').forEach((x) => x.classList.remove('active'));
  b.classList.add('active');
  $('#tab-' + b.dataset.tab).classList.add('active');
  if (b.dataset.tab === 'book') initBookingDefaults();
}));

// ================= 日历：球场+发球机同一时间轴 =================
function renderCalendar() {
  const cal = $('#cal');
  const now = STATE.now;
  const hour0 = 7, hour1 = 22;
  const startOf = new Date(now); startOf.setHours(0, 0, 0, 0);
  const axisStart = startOf.getTime() + hour0 * 3600e3;
  const axisEnd = startOf.getTime() + hour1 * 3600e3;
  const span = axisEnd - axisStart;
  const pct = (ms) => ((ms - axisStart) / span) * 100;

  let html = '<div class="hours">';
  for (let h = hour0; h < hour1; h++) html += `<span>${pad(h)}:00</span>`;
  html += '</div>';

  const courts = STATE.availability.courts;
  const machines = STATE.availability.machines;
  const bookings = STATE.bookings;

  // 计算每条赛道上的重叠集合（仅占锁状态），冲突叠红边
  const locking = new Set(['confirmed', 'issued', 'rain_stopped']);
  const conflictIds = new Set();
  function markOverlap(resourceKey) {
    const groups = {};
    for (const b of bookings) {
      if (!locking.has(b.status)) continue;
      const k = b[resourceKey];
      (groups[k] = groups[k] || []).push(b);
    }
    for (const list of Object.values(groups)) {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i], c = list[j];
          if (a.start_ms < c.end_ms && a.end_ms > c.start_ms) { conflictIds.add(a.id); conflictIds.add(c.id); }
        }
      }
    }
  }
  markOverlap('court_id');
  markOverlap('machine_id');

  const visible = (b) => b.end_ms > axisStart && b.start_ms < axisEnd;

  function lane(title, isMachine, resourceId, name) {
    const items = bookings.filter((b) => visible(b) && b[isMachine ? 'machine_id' : 'court_id'] === resourceId);
    let rows = `<div class="lane ${isMachine ? 'machine-lane' : 'court-lane'}">
      <div class="lane-label"><span class="dot" style="background:${isMachine ? 'var(--grass)' : 'var(--brick)'}"></span>${esc(name)}</div>
      <div class="lane-track">`;
    for (const b of items) {
      const left = Math.max(0, pct(Math.max(b.start_ms, axisStart)));
      const width = Math.min(100, pct(Math.min(b.end_ms, axisEnd))) - left;
      const who = b.member ? b.member.name : '';
      const res = isMachine ? b.court.name : b.machine.code;
      const halo = conflictIds.has(b.id) ? ' halo-conflict' : '';
      rows += `<div class="blk ${b.status}${halo}" style="left:${left}%;width:${width}%"
        data-id="${b.id}" title="${esc(b.code)} ${esc(who)} ${hm(b.start_ms)}-${hm(b.end_ms)}">
        <b>${esc(b.code)}</b>${esc(who)} · ${esc(res)} · ${hm(b.start_ms)}-${hm(b.end_ms)}</div>`;
    }
    rows += '</div></div>';
    return rows;
  }

  html += '<div class="group-title">球 场</div>';
  for (const c of courts) html += lane(c.name, false, c.id, c.name);
  html += '<div class="group-title machines">发 球 机</div>';
  for (const m of machines) {
    html += lane(m.code, true, m.id, `${m.code}${m.status === 'maintenance' ? '（维修中）' : ''}`);
  }

  if (now > axisStart && now < axisEnd) {
    html += `<div class="now-line" style="left:calc(118px + ${pct(now)}% * (100% - 118px) / 100)"></div>`;
  }
  cal.innerHTML = html;

  // now-line 定位需按 lane-track 实际宽度
  const trackWidth = cal.querySelector('.lane-track')?.offsetWidth || 0;
  const line = cal.querySelector('.now-line');
  if (line && trackWidth) line.style.left = `${118 + (pct(now) / 100) * trackWidth}px`;

  $$('.blk', cal).forEach((el) => el.addEventListener('click', () => openOrder(el.dataset.id)));
}

// ================= 新建预约 =================
function fillSelect(sel, items, val, render) {
  sel.innerHTML = items.map((it) => {
    const { value, label, disabled } = render(it);
    return `<option value="${esc(value)}"${disabled ? ' disabled' : ''}${value === val ? ' selected' : ''}>${esc(label)}</option>`;
  }).join('');
}

function initBookingDefaults() {
  const fMember = $('#fMember'), fCourt = $('#fCourt'), fMachine = $('#fMachine'), fMode = $('#fMode');
  if (fMember.options.length && fMember.dataset.filled) return;
  fillSelect(fMember, STATE.members, STATE.members[0]?.id, (m) => ({ value: m.id, label: `${m.name}（押金 ${yuan(m.deposit_balance)}）` }));
  fillSelect(fCourt, STATE.availability.courts, null, (c) => ({
    value: c.id,
    label: `${c.name}${c.rain_suspended ? '（雨天停场）' : c.status !== 'active' ? '（关闭）' : ''}`,
    disabled: c.rain_suspended || c.status !== 'active',
  }));
  fillSelect(fMachine, STATE.availability.machines, null, (m) => ({
    value: m.id, label: `${m.code} ${m.model}${m.status === 'maintenance' ? '（维修中）' : ''}`,
    disabled: m.status === 'maintenance',
  }));
  fillSelect(fMode, [{ id: '', name: '不使用训练模式（仅场地）' }, ...STATE.modes], null, (mo) => ({ value: mo.id, label: mo.id ? `${mo.name} ${yuan(mo.fee_per_hour)}/时 · ${mo.balls_per_hour}球/时` : mo.name }));
  fMember.dataset.filled = '1';

  // 默认时段：从下一个半点开始 1 小时
  const t = Math.ceil((STATE.now + 5 * 60e3) / (30 * 60e3)) * 30 * 60e3;
  $('#fStart').value = dtLocal(t);
  $('#fEnd').value = dtLocal(t + 3600e3);
  updateFeePreview();

  if (!fMember.dataset.chips) {
    fMember.dataset.chips = '1';
    $$('#demoChips button').forEach((btn) => btn.addEventListener('click', () => {
      const live = STATE.bookings.find((b) => b.status === 'issued') || STATE.bookings.find((b) => b.status === 'confirmed');
      if (!live) { toast('当前没有可撞的订单', 'err'); return; }
      // 时段取与目标订单重叠的 1 小时窗口
      const s = Math.max(live.start_ms, STATE.now);
      const e = Math.min(live.end_ms, s + 60 * 60e3);
      $('#fStart').value = dtLocal(s);
      $('#fEnd').value = dtLocal(e > s ? e : s + 3600e3);
      if (btn.dataset.demo === 'court') {
        $('#fCourt').value = live.court_id;
        const other = STATE.availability.machines.find((m) => m.id !== live.machine_id && m.status === 'ok');
        if (other) $('#fMachine').value = other.id;
      } else if (btn.dataset.demo === 'machine') {
        $('#fMachine').value = live.machine_id;
        const other = STATE.availability.courts.find((c) => c.id !== live.court_id && !c.rain_suspended && c.status === 'active');
        if (other) $('#fCourt').value = other.id;
      } else {
        const broken = STATE.availability.machines.find((m) => m.status === 'maintenance');
        if (broken) $('#fMachine').value = broken.id;
      }
      updateFeePreview();
      toast('已填充冲突/维修样例，点击“确认预约”查看拦截结果', 'ok');
    }));
  }
}

function updateFeePreview() {
  const mode = STATE.modes.find((m) => m.id === $('#fMode').value);
  const s = new Date($('#fStart').value).getTime();
  const e = new Date($('#fEnd').value).getTime();
  $('#feePreview').textContent = mode && e > s ? yuan(Math.round(mode.fee_per_hour * ((e - s) / 3600e3))) : '¥0';
}
['fMode', 'fStart', 'fEnd'].forEach((id) => document.getElementById(id).addEventListener('change', updateFeePreview));

$('#bookingForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const hint = $('#conflictHint');
  hint.innerHTML = '';
  try {
    const b = await api('/api/bookings', {
      method: 'POST',
      body: {
        memberId: $('#fMember').value,
        courtId: $('#fCourt').value,
        machineId: $('#fMachine').value,
        modeId: $('#fMode').value || null,
        startMs: new Date($('#fStart').value).getTime(),
        endMs: new Date($('#fEnd').value).getTime(),
      },
    });
    toast(`预约 ${b.code} 已确认，球场与发球机已锁定`);
    await refresh();
    openOrder(b.id);
  } catch (err) {
    const withInfo = err.info && err.info.conflicts ? `（冲突订单：${err.info.conflicts.join('、')}）` : '';
    hint.innerHTML = `<div class="diff-box short" style="text-align:left">⛔ ${esc(err.message)}${esc(withInfo)}</div>`;
    toast(err.message, 'err');
  }
});

function renderBookAvailability() {
  const box = $('#bookAvailability');
  const a = STATE.availability;
  box.innerHTML = `
    <div class="kvline">可用球场：<b>${a.courts.filter((c) => !c.rain_suspended && c.status === 'active').length}/${a.courts.length}</b></div>
    <div class="kvline">可用发球机：<b>${a.machines.filter((m) => m.status === 'ok').length}/${a.machines.length}</b>（维修 ${a.machines.filter((m) => m.status === 'maintenance').length} 台）</div>
    <div class="kvline">可分配电池：<b>${a.batteries.filter((x) => x.assignable).length}/${a.batteries.length}</b>（领用门槛 ≥ ${a.thresholds.minIssueCharge}%，充电中不可分配）</div>
    <div class="kvline">空闲球筐：<b>${a.baskets.filter((x) => x.status === 'available').length}/${a.baskets.length}</b></div>
    ${STATE.weather.condition === 'rain' ? '<div class="rain-banner">🌧 当前降雨，所有开放球场已暂停，进行中订单可按雨停归还（按实际时长计费）。</div>' : ''}
  `;
}

// ================= 订单列表 =================
function renderOrders() {
  const box = $('#ordersList');
  const rows = [...STATE.bookings].sort((a, b) => b.start_ms - a.start_ms);
  if (!rows.length) { box.innerHTML = '<div class="empty">今日暂无预约</div>'; return; }
  box.innerHTML = `<table class="list">
    <thead><tr><th>订单</th><th>会员</th><th>场地 / 机器</th><th>时段</th><th>状态</th><th>领用</th><th>归还</th><th>费用/押金</th><th></th></tr></thead>
    <tbody>${rows.map((b) => `
      <tr class="clickable" data-id="${b.id}">
        <td><b>${esc(b.code)}</b><br><span style="color:var(--ink-soft);font-size:11px">${b.mode ? esc(b.mode.name) : '纯场地'}</span></td>
        <td>${esc(b.member.name)}</td>
        <td>${esc(b.court.name)}<br><span style="color:var(--grass-dark)">${esc(b.machine.code)}</span></td>
        <td>${hm(b.start_ms)}–${hm(b.end_ms)}</td>
        <td><span class="tag ${b.status}">${STATUS_LABEL[b.status] || b.status}</span></td>
        <td>${b.basket ? `${esc(b.basket.code)} · ${b.balls_issued}球<br><span style="font-size:11px">${esc(b.battery.code)}</span>` : '—'}</td>
        <td>${b.balls_returned == null ? '—' : `${b.balls_returned}球${b.balls_returned - b.balls_issued < 0 ? ` <b style="color:var(--danger)">差${b.balls_issued - b.balls_returned}</b>` : ''}`}</td>
        <td>${yuan(b.fee)}<br><span style="font-size:11px;color:var(--ink-soft)">冻 ${yuan(b.deposit_held)}</span></td>
        <td class="stop-pop">${quickActions(b)}</td>
      </tr>`).join('')}
    </tbody></table>`;

  $$('#ordersList tr.clickable').forEach((tr) => tr.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    openOrder(tr.dataset.id);
  }));
  $$('#ordersList button[data-act]').forEach((btn) => btn.addEventListener('click', (e) => {
    e.stopPropagation();
    handleQuick(btn.dataset.act, btn.dataset.id);
  }));
}

function quickActions(b) {
  const acts = [];
  if (b.status === 'confirmed') {
    acts.push(['pickup', '领用', 'grass']);
    acts.push(['extend', '续场', 'ghost']);
    acts.push(['cancel', '取消', 'ghost']);
  } else if (b.status === 'issued') {
    acts.push(['return', '归还清点', 'grass']);
    acts.push(['extend', '续场', 'ghost']);
    acts.push(['jam', '卡球', 'warn']);
    acts.push(['swap', '换电池', 'ghost']);
  } else if (b.status === 'returned' || b.status === 'rain_stopped') {
    acts.push(['settle', '结单', 'grass']);
  }
  acts.push(['detail', '详情', 'ghost']);
  return acts.map(([act, label, cls]) => `<button class="btn small ${cls}" data-act="${act}" data-id="${b.id}">${label}</button>`).join(' ');
}

async function handleQuick(act, id) {
  if (act === 'detail') return openOrder(id);
  if (act === 'pickup') return openPickup(id);
  if (act === 'return') return openReturn(id);
  if (act === 'extend') return openExtend(id);
  if (act === 'jam') return openJam(id);
  if (act === 'swap') return openSwap(id);
  if (act === 'cancel') {
    if (!confirm('确认取消该预约？锁定的球场与发球机将立即释放。')) return;
    await api(`/api/bookings/${id}/cancel`, { method: 'POST', body: { actor: 'staff' } });
    toast('预约已取消');
    return refresh();
  }
  if (act === 'settle') {
    try {
      const r = await api(`/api/bookings/${id}/settle`, { method: 'POST' });
      toast(`订单 ${r.code} 已结单，支付 ${yuan(r.fee)}`);
    } catch (e) {
      toast(e.message, 'err');
      openDeductionsHint(id, e);
    }
    return refresh();
  }
}

function openDeductionsHint(id, e) {
  if (e.code === 'deduction_pending') {
    $$('#tabs button').forEach((x) => x.classList.toggle('active', x.dataset.tab === 'deductions'));
    $$('.tabpane').forEach((x) => x.classList.toggle('active', x.id === 'tab-deductions'));
  }
}

// ================= 弹层框架 =================
function openModal(html) {
  $('#modalBox').innerHTML = html;
  $('#modalMask').classList.add('open');
}
function closeModal() { $('#modalMask').classList.remove('open'); }
$('#modalMask').addEventListener('click', (e) => { if (e.target.id === 'modalMask') closeModal(); });

function statusTag(s) { return `<span class="tag ${s}">${STATUS_LABEL[s] || s}</span>`; }

async function openOrder(id) {
  const b = await api(`/api/bookings/${id}`);
  const isLive = b.status === 'issued';
  openModal(`
    <h2>订单 ${esc(b.code)} ${statusTag(b.status)}</h2>
    <div class="kvline">
      会员：<b>${esc(b.member.name)}</b>（${esc(b.member.level || '')}，押金余额 ${yuan(b.member.deposit_balance)}）<br>
      场地：<b>${esc(b.court.name)}</b> ｜ 发球机：<b>${esc(b.machine.code)} ${esc(b.machine.model)}</b><br>
      时段：<b>${mdhm(b.start_ms)} – ${mdhm(b.end_ms)}</b><br>
      模式：<b>${b.mode ? esc(b.mode.name) + ' · ' + yuan(b.mode.fee_per_hour) + '/时' : '纯场地'}</b> ｜ 费用 <b>${yuan(b.fee)}</b> ｜ 冻结押金 <b>${yuan(b.deposit_held)}</b>
    </div>
    ${isLive ? `<div class="card" style="margin:12px 0;padding:10px"><div class="timer" id="mTimer">--:--</div><div class="timer-label" id="mTimerLabel">训练计时中</div></div>` : ''}
    <div class="kvline" style="margin-top:8px">
      领用：${b.basket ? `${esc(b.basket.code)}（容量 ${b.basket.capacity}）领出 <b>${b.balls_issued}</b> 球，电池 <b>${esc(b.battery.code)}</b>` : '未领用'}<br>
      归还：${b.balls_returned == null ? '—' : `<b>${b.balls_returned}</b> 球 ${ballDiff(b)}；电池已接入充电：<b>${b.charging_ack ? '是' : '否'}</b>`}
      ${b.rain_stopped_at ? '<br>🌧 雨天停场，费用已按实际训练时长折算' : ''}
      ${b.late_released_at ? `<br>迟到释放：${mdhm(b.late_released_at)}` : ''}
    </div>
    ${b.deductions.length ? `<h3 style="margin:14px 0 6px;font-size:14px">押金扣款</h3>${b.deductions.map(dedRow).join('')}` : ''}
    <h3 style="margin:14px 0 6px;font-size:14px">处理记录</h3>
    <ul class="timeline">${b.events.map((ev) => `<li><span class="ev-time">${mdhm(ev.at)}</span><b>${esc(EVENT_LABEL[ev.type] || ev.type)}</b> ${ev.detail ? esc(renderDetail(ev)) : ''}</li>`).join('')}</ul>
    <div class="btn-row" style="margin-top:14px">${quickActions(b)}</div>
  `);
  $$('#modalBox button[data-act]').forEach((btn) => btn.addEventListener('click', () => {
    closeModal();
    handleQuick(btn.dataset.act, btn.dataset.id);
  }));
  if (isLive) startModalTimer(b);
}

const EVENT_LABEL = {
  created: '创建预约', pickup: '开场领用', return: '归还清点', settled: '订单结单',
  cancelled: '取消预约', extended: '临时续场', late_released: '迟到释放',
  jam: '卡球登记', 'battery.swap': '电池掉电更换', 'rain.alert': '降雨提醒',
  'deduction.proposed': '发起扣款', 'deduction.confirmed': '经理确认扣款', 'deduction.rejected': '扣款驳回',
};
function renderDetail(ev) {
  const d = ev.detail || {};
  if (ev.type === 'pickup') return `${d.batteryCode} / ${d.basketCode} / ${d.balls}球`;
  if (ev.type === 'return') return `还 ${d.ballsReturned}球${d.rain ? '（雨停）' : ''}${d.shortage ? `，差 ${d.shortage}` : ''}`;
  if (ev.type === 'extended') return `+${d.minutes} 分钟`;
  if (ev.type === 'settled') return `支付流水 ${d.ref || ''}`;
  return typeof d === 'object' ? '' : String(d);
}

function ballDiff(b) {
  const diff = b.balls_returned - b.balls_issued;
  if (diff === 0) return '<b style="color:var(--ok)">数量一致</b>';
  if (diff < 0) return `<b style="color:var(--danger)">短缺 ${-diff} 颗</b>`;
  return `<b style="color:var(--warn)">多 ${diff} 颗</b>`;
}

function dedRow(d) {
  const map = { proposed: '待复核', confirmed: '已确认', rejected: '已驳回' };
  return `<div class="ded-card ${d.status}" style="margin:6px 0">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <span class="tag ${d.status === 'proposed' ? 'released' : d.status}">${map[d.status]}</span>
      <span class="ded-amount">${yuan(d.amount)}</span>
    </div>
    <div class="evidence">依据：${esc(d.detail || '')}${d.manager ? `<br>经理：${esc(d.manager)}｜流水：${esc(d.payment_ref || '')}` : ''}</div>
  </div>`;
}

// ================= 训练计时 =================
let modalTimerHandle = null;
function startModalTimer(b) {
  clearInterval(modalTimerHandle);
  const el = $('#mTimer'), label = $('#mTimerLabel');
  const draw = () => {
    if (!el) return clearInterval(modalTimerHandle);
    const now = Date.now();
    const used = now - b.pickup_at;
    const total = b.end_ms - b.pickup_at;
    const sign = used >= total ? '+' : '';
    const abs = Math.abs(used - total);
    el.innerHTML = `<span class="${used > total ? 'over' : ''}">${sign}${fmtDur(abs)}</span>`;
    el.querySelector('span').className = used > total ? 'over' : '';
    label.textContent = used > total ? `已超过预计结束 ${hm(b.end_ms)}（可续场或归还）` : `距结束 ${hm(b.end_ms)} 剩余`;
    // 前置已用时长
    el.title = `已训练 ${fmtDur(used)}`;
  };
  draw();
  modalTimerHandle = setInterval(draw, 1000);
}
function fmtDur(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

// ================= 领用弹层 =================
async function openPickup(id) {
  const b = await api(`/api/bookings/${id}`);
  const bats = STATE.availability.batteries;
  const baskets = STATE.availability.baskets;
  const defBasket = baskets.find((x) => x.status === 'available');
  openModal(`
    <h2>开场领用 · ${esc(b.code)}</h2>
    <div class="sub">领取电池与球筐并记录领出球数。维修中的机器与充电未完成的电池不可分配。</div>
    <label class="field"><span>电池（≥ ${STATE.availability.thresholds.minIssueCharge}%）</span>
      <select id="pBattery">${bats.map((x) => `<option value="${x.id}" ${x.status !== 'ready' || !x.assignable ? 'disabled' : ''}>${x.code} · ${x.charge_pct}% · ${x.status === 'ready' ? (x.assignable ? '可领用' : '电量不足') : x.status === 'charging' ? '充电未完成' : '使用中'}</option>`).join('')}</select>
    </label>
    <label class="field"><span>球筐</span>
      <select id="pBasket">${baskets.map((x) => `<option value="${x.id}" ${x.status !== 'available' ? 'disabled' : ''}>${x.code} · 容量 ${x.capacity} · ${x.status === 'available' ? '空闲' : '使用中'}</option>`).join('')}</select>
    </label>
    <label class="field"><span>领出网球数量</span><input type="number" id="pBalls" min="1" value="${defBasket ? defBasket.capacity : 60}"></label>
    <div class="btn-row"><button class="btn grass" id="pOk">确认领用并开始计时</button><button class="btn ghost" id="pNo">取消</button></div>
  `);
  $('#pNo').onclick = closeModal;
  $('#pOk').onclick = async () => {
    try {
      const r = await api(`/api/bookings/${id}/pickup`, {
        method: 'POST',
        body: { batteryId: $('#pBattery').value, basketId: $('#pBasket').value, balls: Number($('#pBalls').value) },
      });
      toast(`已领用 ${r.battery.code} / ${r.basket.code} / ${r.balls_issued} 球，计时开始`);
      closeModal(); refresh();
    } catch (e) { toast(e.message, 'err'); }
  };
}

// ================= 归还清点（大数字步进器；雨停条在文档流内，不遮挡结果）=================
async function openReturn(id) {
  const b = await api(`/api/bookings/${id}`);
  const raining = STATE.weather.condition === 'rain';
  let count = b.balls_issued;
  const tol = STATE.constants.BALL_TOLERANCE;
  const price = STATE.constants.BALL_PRICE;

  openModal(`
    <h2>归还清点 · ${esc(b.code)}</h2>
    <div id="rainSlot">${raining ? `<div class="rain-banner">🌧 当前降雨：勾选下方"雨天停场归还"，费用按已训练时长折算，球场暂时挂旗。<button class="close" type="button" onclick="this.parentElement.remove()">×</button></div>` : ''}</div>
    <div class="kvline">领出 <b>${b.balls_issued}</b> 球 ｜ 球筐 <b>${esc(b.basket.code)}</b> ｜ 电池 <b>${esc(b.battery.code)}</b>。归还后电池立即接入充电，清点完成方可结单。</div>

    <div class="stepper">
      <button type="button" id="sMinus" aria-label="减少">−</button>
      <div class="num"><b id="sNum">${count}</b><small>归还散球 / 球筐清点（颗）</small></div>
      <button type="button" class="plus" id="sPlus" aria-label="增加">+</button>
    </div>
    <div class="quick-jumps">
      <button type="button" data-j="-10">−10</button>
      <button type="button" data-j="-5">−5</button>
      <button type="button" data-j="-1">−1</button>
      <button type="button" data-j="0">点清一致</button>
      <button type="button" data-j="1">+1</button>
    </div>
    <div class="diff-box" id="sDiff"></div>

    <div class="return-stack" style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
      <label class="field" style="margin:0"><span>电池剩余电量 %</span><input type="number" id="rPct" min="5" max="100" value="30"></label>
      <label class="field" style="margin:0;display:flex;align-items:center;gap:8px;margin-top:22px">
        <input type="checkbox" id="rRain" style="width:auto" ${raining ? 'checked' : ''}> 雨天停场归还（按时长折算）
      </label>
    </div>
    <label class="field" style="display:flex;align-items:center;gap:8px;margin-top:10px">
      <input type="checkbox" id="rScratch" style="width:auto"> 设备有刮伤（自动生成 ¥${STATE.constants.SCRATCH_FEE} 扣款建议，待经理复核）
    </label>
    <label class="field"><span>刮伤 / 异常备注</span><input type="text" id="rScratchNote" placeholder="如：球筐边沿掉漆"></label>

    <div class="btn-row"><button class="btn grass" id="rOk">确认归还并接入充电</button><button class="btn ghost" id="rNo">取消</button></div>
  `);

  const num = $('#sNum'), diff = $('#sDiff');
  const draw = () => {
    num.textContent = count;
    const d = count - b.balls_issued;
    if (d === 0) {
      diff.className = 'diff-box';
      diff.innerHTML = '数量一致，可以结单';
    } else if (d < 0) {
      const short = -d;
      const billable = Math.max(0, short - tol);
      diff.className = 'diff-box short';
      diff.innerHTML = `<span class="big">短缺 ${short} 颗</span>含 ${tol} 颗合理损耗，超出 ${billable} 颗按 ¥${price}/颗 建议扣款 <b>¥${billable * price}</b>（经理复核后生效）`;
    } else {
      diff.className = 'diff-box over';
      diff.innerHTML = `<span class="big">多出 ${d} 颗</span>请核对是否混入其他球筐的球`;
    }
  };
  const setCount = (v) => { count = Math.max(0, Math.min(120, v)); draw(); };
  $('#sMinus').onclick = () => setCount(count - 1);
  $('#sPlus').onclick = () => setCount(count + 1);
  $$('.quick-jumps button').forEach((btn) => btn.onclick = () => {
    const j = Number(btn.dataset.j);
    setCount(j === 0 ? b.balls_issued : count + j);
  });
  draw();

  $('#rNo').onclick = closeModal;
  $('#rOk').onclick = async () => {
    const scratchChecked = $('#rScratch').checked;
    try {
      const r = await api(`/api/bookings/${id}/return`, {
        method: 'POST',
        body: {
          ballsReturned: count,
          rain: $('#rRain').checked,
          scratch: scratchChecked,
          scratchNote: $('#rScratchNote').value || null,
          batteryPct: Number($('#rPct').value),
        },
      });
      const d = r.balls_returned - r.balls_issued;
      toast(d < 0 ? `已归还，短缺 ${-d} 颗，等待经理复核扣款` : '归还完成，电池已接入充电', d < 0 ? 'err' : 'ok');
      closeModal();
      await refresh();
      if (d === 0 && !scratchChecked) openOrder(r.id); // 无差异：打开详情直接结单
    } catch (e) { toast(e.message, 'err'); }
  };
}

// ================= 续场 =================
async function openExtend(id) {
  const b = await api(`/api/bookings/${id}`);
  openModal(`
    <h2>临时续场 · ${esc(b.code)}</h2>
    <div class="kvline">当前结束：<b>${mdhm(b.end_ms)}</b>。续场将重新检查球场与发球机的后续预约，任一冲突即拒绝。</div>
    <div class="btn-row" style="margin:12px 0">
      ${[30, 60, 90, 120].map((m) => `<button class="btn grass" data-min="${m}">+${m} 分钟</button>`).join('')}
    </div>
    <button class="btn ghost" id="eNo">取消</button>
  `);
  $('#eNo').onclick = closeModal;
  $$('#modalBox button[data-min]').forEach((btn) => btn.onclick = async () => {
    try {
      const r = await api(`/api/bookings/${id}/extend`, { method: 'POST', body: { minutes: Number(btn.dataset.min) } });
      toast(`续场成功，新结束时间 ${hm(r.end_ms)}，费用 ${yuan(r.fee)}`);
      closeModal(); refresh();
    } catch (e) {
      toast(e.message + (e.info && e.info.conflicts ? `（与 ${e.info.conflicts.join('、')} 冲突）` : ''), 'err');
    }
  });
}

// ================= 卡球 / 换电池 =================
async function openJam(id) {
  openModal(`
    <h2>卡球登记</h2>
    <label class="field"><span>情况说明</span><input type="text" id="jNote" value="出球口卡球"></label>
    <label class="field" style="display:flex;align-items:center;gap:8px"><input type="checkbox" id="jFixed" style="width:auto" checked> 现场已清除，无需停机维修</label>
    <div class="btn-row">
      <button class="btn grass" id="jOk">提交</button>
      <button class="btn danger" id="jRepair">无法清除，转维修（机器将立即不可分配）</button>
      <button class="btn ghost" id="jNo">取消</button>
    </div>
  `);
  $('#jNo').onclick = closeModal;
  const submit = async (resolved) => {
    try {
      await api(`/api/bookings/${id}/jam`, { method: 'POST', body: { resolved, note: $('#jNote').value } });
      toast(resolved ? '卡球已清除并记录' : '已转维修，机器锁定');
      closeModal(); refresh();
    } catch (e) { toast(e.message, 'err'); }
  };
  $('#jOk').onclick = () => submit(true);
  $('#jRepair').onclick = () => submit(false);
}

async function openSwap(id) {
  const b = await api(`/api/bookings/${id}`);
  const ready = STATE.availability.batteries.filter((x) => x.assignable);
  openModal(`
    <h2>电池掉电更换</h2>
    <div class="kvline">当前电池 <b>${esc(b.battery.code)}</b>（${b.battery.charge_pct}%）将取下接入充电，只能换入已充满（ready）电池。</div>
    ${ready.length ? `<label class="field"><span>换入电池</span><select id="swBat">${ready.map((x) => `<option value="${x.id}">${x.code} · ${x.charge_pct}%</option>`).join('')}</select></label>`
      : '<div class="diff-box short">没有充满的备用电池，不可更换</div>'}
    <div class="btn-row"><button class="btn grass" id="swOk" ${ready.length ? '' : 'disabled'}>确认更换</button><button class="btn ghost" id="swNo">取消</button></div>
  `);
  $('#swNo').onclick = closeModal;
  $('#swOk').onclick = async () => {
    try {
      const r = await api(`/api/bookings/${id}/swap-battery`, { method: 'POST', body: { batteryId: $('#swBat').value } });
      toast(`已更换为 ${r.battery.code}，旧电池充电中`);
      closeModal(); refresh();
    } catch (e) { toast(e.message, 'err'); }
  };
}

// ================= 设备可用表 =================
function renderEquipment() {
  const a = STATE.availability;
  $('#availCourts').innerHTML = a.courts.map((c) => `
    <div class="avail-card ${c.rain_suspended || c.status !== 'active' ? 'unavailable' : ''}">
      <h3>${esc(c.name)} ${c.rain_suspended ? '<span class="tag rain">雨停</span>' : c.status === 'active' ? '<span class="tag available">开放</span>' : '<span class="tag closed">关闭</span>'}</h3>
      <div class="kv">${esc(c.surface)}<br>
        <button class="btn small ghost" data-court-rain="${c.id}" data-sus="${c.rain_suspended ? 0 : 1}">${c.rain_suspended ? '恢复开放' : '标记雨停'}</button>
      </div>
    </div>`).join('');
  $('#availMachines').innerHTML = a.machines.map((m) => `
    <div class="avail-card ${m.status === 'maintenance' ? 'unavailable' : ''}">
      <h3>${esc(m.code)} ${m.status === 'maintenance' ? '<span class="tag maintenance">维修中</span>' : '<span class="tag ok">可用</span>'}</h3>
      ${m.photo ? `<img class="photo-thumb" src="/photos/${encodeURIComponent(m.photo.path)}" alt="${esc(m.code)}照片">` : ''}
      <div class="kv">${esc(m.model)}${m.note ? `<br>原因：${esc(m.note)}` : ''}<br>
        <button class="btn small warn" data-repair="${m.id}" ${m.status === 'maintenance' ? 'disabled' : ''}>登记故障</button></div>
    </div>`).join('');
  $('#availBatteries').innerHTML = a.batteries.map((x) => `
    <div class="avail-card ${x.assignable ? '' : 'unavailable'}">
      <h3>${esc(x.code)} <span class="tag ${x.status}">${x.status === 'ready' ? (x.assignable ? '可领用' : '电量低') : x.status === 'charging' ? '充电中' : '使用中'}</span></h3>
      ${x.photo ? `<img class="photo-thumb" src="/photos/${encodeURIComponent(x.photo.path)}" alt="${esc(x.code)}照片">` : ''}
      <div class="battery-bar"><i class="${x.charge_pct < STATE.constants.MIN_ISSUE_CHARGE ? 'low' : ''}" style="width:${x.charge_pct}%"></i></div>
      <div class="kv">${x.charge_pct}%${x.status === 'charging' ? ` ｜ 预计充满 ${hm(x.charging_until)}` : ''} ｜ 换电 ${x.swap_count} 次</div>
    </div>`).join('');
  $('#availBaskets').innerHTML = a.baskets.map((x) => `
    <div class="avail-card ${x.status === 'available' ? '' : 'unavailable'}">
      <h3>${esc(x.code)} <span class="tag ${x.status}">${x.status === 'available' ? '空闲' : '使用中'}</span></h3>
      ${x.photo ? `<img class="photo-thumb" src="/photos/${encodeURIComponent(x.photo.path)}" alt="${esc(x.code)}照片">` : ''}
      <div class="kv">容量 ${x.capacity} 颗</div>
    </div>`).join('');

  $$('#availCourts button[data-court-rain]').forEach((btn) => btn.onclick = async () => {
    await api(`/api/courts/${btn.dataset.courtRain}/rain`, { method: 'POST', body: { suspended: btn.dataset.sus === '1' } });
    toast(btn.dataset.sus === '1' ? '球场已标记雨停' : '球场已恢复');
    refresh();
  });
  $$('#availMachines button[data-repair]').forEach((btn) => btn.onclick = () => openRepairForm(btn.dataset.repair));

  // 维修单
  const repairs = STATE.repairs;
  $('#repairList').innerHTML = repairs.length ? `<table class="list">
    <thead><tr><th>机器</th><th>原因</th><th>报修</th><th>状态</th><th></th></tr></thead>
    <tbody>${repairs.map((r) => `<tr>
      <td><b>${esc(r.machine_code)}</b></td><td>${esc(r.reason)}</td><td>${mdhm(r.reported_at)}</td>
      <td>${r.status === 'open' ? '<span class="tag maintenance">维修中</span>' : `<span class="tag ready">已修复 ${mdhm(r.resolved_at)}</span>`}</td>
      <td>${r.status === 'open' ? `<button class="btn small grass" data-resolve="${r.id}">修复完成</button>` : ''}</td>
    </tr>`).join('')}</tbody></table>` : '<div class="empty">暂无维修记录</div>';
  $$('#repairList button[data-resolve]').forEach((btn) => btn.onclick = async () => {
    await api(`/api/repairs/${btn.dataset.resolve}/resolve`, { method: 'POST', body: { manager: '经理·周' } });
    toast('维修完成，机器恢复可分配');
    refresh();
  });
}

function openRepairForm(machineId) {
  const reason = prompt('故障现象（机器将立即转入维修，新预约与领用被阻断）', '出球无力 / 异响');
  if (!reason) return;
  api(`/api/machines/${machineId}/repair`, { method: 'POST', body: { reason, reporter: 'staff' } })
    .then(() => { toast('已登记故障并锁定机器'); refresh(); })
    .catch((e) => toast(e.message, 'err'));
}

// ================= 押金复核 =================
function renderDeductions() {
  const list = STATE.deductions;
  const box = $('#deductionList');
  if (!list.length) { box.innerHTML = '<div class="empty">暂无扣款记录</div>'; return; }
  box.innerHTML = list.map((d) => {
    const map = { proposed: ['待经理复核', 'proposed'], confirmed: ['已确认扣款', 'confirmed'], rejected: ['已驳回', 'rejected'] };
    const [label, cls] = map[d.status];
    return `<div class="ded-card ${cls}" style="margin-bottom:12px">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
        <div><b>${esc(d.booking_code)}</b> <span class="tag released">${REASON_LABEL[d.reason_code] || d.reason_code}</span>
          <span class="tag ${cls}" style="margin-left:6px">${label}</span></div>
        <div class="ded-amount">${yuan(d.amount)}</div>
      </div>
      <div class="evidence">归还记录依据：${esc(d.detail || '')}<br>
        发起：${mdhm(d.proposed_at)}${d.manager ? ` ｜ 确认经理：${esc(d.manager)} ｜ 支付流水：${esc(d.payment_ref || '')} ｜ 时间：${mdhm(d.confirmed_at)}` : ''}</div>
      <div class="btn-row">
        ${d.status === 'proposed' ? `
          <button class="btn danger" data-confirm="${d.id}">经理确认扣款</button>
          <button class="btn ghost" data-reject="${d.id}">驳回（不扣押金）</button>` : ''}
        ${d.status === 'confirmed' ? '<span style="color:var(--ok);font-weight:700;font-size:13px">✓ 扣款已完成，重复点击为幂等操作，不会重复扣款</span>' : ''}
      </div>
    </div>`;
  }).join('');
  $$('#deductionList button[data-confirm]').forEach((btn) => btn.onclick = async () => {
    try {
      const r = await api(`/api/deductions/${btn.dataset.confirm}/confirm`, { method: 'POST', body: { manager: '经理·周', role: 'manager' } });
      toast(r.idempotent ? '该扣款此前已确认（幂等返回，未重复扣款）' : '扣款已确认并从押金扣除', r.idempotent ? 'ok' : 'ok');
    } catch (e) { toast(e.message, 'err'); }
    refresh();
  });
  $$('#deductionList button[data-reject]').forEach((btn) => btn.onclick = async () => {
    await api(`/api/deductions/${btn.dataset.reject}/reject`, { method: 'POST', body: { manager: '经理·周', role: 'manager' } });
    toast('已驳回，订单可结单');
    refresh();
  });
}
const REASON_LABEL = { balls_short: '球数短缺', scratch: '设备刮伤', equipment_damage: '设备损坏' };

// ================= 事件流 =================
function renderIncidents() {
  const list = STATE.incidents;
  const label = { jam: '卡球', battery_dead: '电池掉电', scratch: '刮伤', rain: '雨天停场' };
  $('#incidentList').innerHTML = list.length ? `<table class="list">
    <thead><tr><th>时间</th><th>订单</th><th>类型</th><th>详情</th></tr></thead>
    <tbody>${list.map((i) => `<tr>
      <td>${mdhm(i.at)}</td><td>${i.booking_code ? `<a href="#" data-order="${i.booking_id}" style="color:var(--brick)">${esc(i.booking_code)}</a>` : '—'}</td>
      <td><span class="tag ${i.kind === 'rain' ? 'rain' : i.kind === 'jam' ? 'maintenance' : 'released'}">${label[i.kind] || i.kind}</span></td>
      <td style="color:var(--ink-soft)">${esc(typeof i.detail === 'string' ? i.detail : JSON.stringify(i.detail))}</td>
    </tr>`).join('')}</tbody></table>` : '<div class="empty">暂无事件</div>';
  $$('#incidentList a[data-order]').forEach((a) => a.onclick = (e) => { e.preventDefault(); openOrder(a.dataset.order); });
}

// ================= 调度器信息 =================
function renderScheduler() {
  const s = STATE.scheduler;
  const w = STATE.weather;
  $('#weatherChip').textContent = `${w.label} ${w.temp}℃`;
  $('#weatherChip').className = 'weather-chip' + (w.condition === 'rain' ? ' rain' : '');
  if (!s) { $('#schedulerInfo').textContent = '调度器未启用'; return; }
  const last = s.lastTick;
  const r = last?.result || {};
  $('#schedulerInfo').innerHTML = `
    每 ${s.intervalMs / 1000} 秒扫描一次：迟到释放（开场 15 分钟未领用）、充电完成（${STATE.constants.CHARGE_MS / 60000} 分钟充满）、天气挂旗。<br>
    上次扫描 ${last ? mdhm(last.at) : '—'}：
    <b style="color:var(--brick)">迟到释放 ${r.lateReleased?.length || 0}</b>（${esc((r.lateReleased || []).join('、') || '无')}）、
    <b style="color:var(--grass)">充电完成 ${r.chargesCompleted?.length || 0}</b>（${esc((r.chargesCompleted || []).join('、') || '无')}）、
    <b style="color:var(--info)">雨停 ${r.rainCourts?.length || 0}</b>${r.rainResumed?.length ? `、恢复 ${r.rainResumed.length}` : ''}
  `;
}

// ================= 刷新循环 =================
async function refresh() {
  STATE = await api('/api/state');
  renderCalendar();
  renderBookAvailability();
  renderOrders();
  renderEquipment();
  renderDeductions();
  renderIncidents();
  renderScheduler();
  if ($('#fMember') && $('#fMember').options.length) {
    fillSelect($('#fCourt'), STATE.availability.courts, $('#fCourt').value, (c) => ({
      value: c.id, label: `${c.name}${c.rain_suspended ? '（雨天停场）' : ''}`, disabled: c.rain_suspended || c.status !== 'active',
    }));
    fillSelect($('#fMachine'), STATE.availability.machines, $('#fMachine').value, (m) => ({
      value: m.id, label: `${m.code}${m.status === 'maintenance' ? '（维修中）' : ''}`, disabled: m.status === 'maintenance',
    }));
  }
}

function tickClock() {
  const d = new Date();
  $('#clock').textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

$('#btnTick').onclick = async () => {
  await api('/api/tick', { method: 'POST' });
  await refresh();
  toast('已执行一次调度扫描');
};

(async function boot() {
  tickClock();
  setInterval(tickClock, 1000);
  try {
    await refresh();
  } catch (e) {
    toast('初始化失败：' + e.message, 'err');
  }
  timerTick = setInterval(refresh, 5000);
  initBookingDefaults();
})();
