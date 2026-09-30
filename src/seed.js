'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { openDb } = require('./db');
const { ClubService, WeatherAdapter, PaymentAdapter, constants } = require('./service');
const { uid, dayStart } = require('./util');

// 生成一张简易 SVG 占位"设备照片"存到本地目录
function writePlaceholderPhoto(dir, kind, code, colors) {
  fs.mkdirSync(dir, { recursive: true });
  const file = `${kind}_${code}.svg`;
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" viewBox="0 0 320 200">
  <rect width="320" height="200" fill="${colors[0]}"/>
  <rect x="10" y="10" width="300" height="180" fill="none" stroke="#ffffff" stroke-width="3"/>
  <rect x="24" y="70" width="272" height="60" rx="8" fill="${colors[1]}"/>
  <text x="160" y="108" font-family="sans-serif" font-size="26" font-weight="bold"
        text-anchor="middle" fill="#ffffff">${code}</text>
  <text x="160" y="166" font-family="sans-serif" font-size="14"
        text-anchor="middle" fill="rgba(255,255,255,.85)">设备存档照片（演示占位图）</text>
</svg>`;
  fs.writeFileSync(path.join(dir, file), svg);
  return file;
}

// 直接构造一行（绕过服务校验，用于历史样例）
function insert(db, table, row) {
  const cols = Object.keys(row);
  const ph = cols.map(() => '?').join(',');
  db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${ph})`)
    .run(...cols.map((c) => row[c]));
}

function seed(dbFile, photoDir, opts = {}) {
  if (dbFile !== ':memory:' && fs.existsSync(dbFile) && opts.reset) {
    for (const suffix of ['', '-wal', '-shm']) {
      fs.rmSync(dbFile + suffix, { force: true });
    }
  }
  const db = openDb(dbFile);
  // 演示时钟：锚定到今天 14:00（日历 07:00–22:00 窗口正中），之后按真实速率流逝。
  // 这样启动即可看到进行中 / 待领用 / 迟到释放 / 短缺 / 雨停 / 维修等样例。
  const bootReal = Date.now();
  const demoAnchor = dayStart() + 14 * 3600e3;
  const now = demoAnchor;
  const svc = new ClubService(db, {
    weather: new WeatherAdapter(),
    now: () => demoAnchor + (Date.now() - bootReal),
    photoDir,
  });

  const existing = db.prepare(`SELECT COUNT(*) c FROM courts`).get().c;
  if (existing) {
    return { db, svc, skipped: true };
  }

  // ---- 球场（硬地：砖红/草绿）----
  const courts = [
    ['c1', '中央 1 号场', '硬地·砖红'],
    ['c2', '东侧 2 号场', '硬地·砖红'],
    ['c3', '西侧 3 号场', '硬地·草绿'],
  ];
  for (const [id, name, surface] of courts) {
    insert(db, 'courts', { id, name, surface, status: 'active', rain_suspended: 0 });
  }

  // ---- 发球机：PM-103 维修中 ----
  const machines = [
    ['m1', 'PM-101', 'TennisJet Pro 2'],
    ['m2', 'PM-102', 'TennisJet Pro 2'],
    ['m3', 'PM-103', 'TennisJet Lite'],
    ['m4', 'PM-104', 'TennisJet Lite'],
  ];
  for (const [id, code, model] of machines) {
    insert(db, 'machines', { id, code, model, status: id === 'm3' ? 'maintenance' : 'ok', note: id === 'm3' ? '出球口卡球' : null });
  }
  insert(db, 'repairs', {
    id: uid('rep'), machine_id: 'm3', reason: '出球口卡球，等待更换胶轮',
    status: 'open', reporter: 'staff', repair_fee: 120, reported_at: now - 50 * 60e3, resolved_at: null,
  });

  // ---- 电池：BAT-C 充电中（未完成不可分配）----
  insert(db, 'batteries', { id: 'bA', code: 'BAT-A', status: 'in_use', charge_pct: 64, charge_started_at: null, charging_until: null, swap_count: 0 });
  insert(db, 'batteries', { id: 'bB', code: 'BAT-B', status: 'charging', charge_pct: 35,
    charge_started_at: now - 12 * 60e3, charging_until: now + (constants.CHARGE_MS - 12 * 60e3), swap_count: 1 });
  insert(db, 'batteries', { id: 'bC', code: 'BAT-C', status: 'ready', charge_pct: 100, charge_started_at: null, charging_until: null, swap_count: 0 });
  insert(db, 'batteries', { id: 'bD', code: 'BAT-D', status: 'ready', charge_pct: 91, charge_started_at: null, charging_until: null, swap_count: 0 });

  // ---- 球筐 ----
  const baskets = [
    ['k1', 'BK-01', 60, 'in_use'],
    ['k2', 'BK-02', 60, 'available'],
    ['k3', 'BK-03', 48, 'available'],
    ['k4', 'BK-04', 60, 'available'],
    ['k5', 'BK-05', 48, 'available'],
  ];
  for (const [id, code, cap, status] of baskets) {
    insert(db, 'baskets', { id, code, capacity: cap, status });
  }

  // ---- 会员（演示押金余额）----
  const members = [
    ['u1', '林晓', '138-0001', '进阶 3.5', 300],
    ['u2', '陈磊', '138-0002', '中级 3.0', 300],
    ['u3', '王敏', '138-0003', '初级 2.5', 180],
    ['u4', '赵雨桐', '138-0004', '高级 4.0', 500],
  ];
  for (const [id, name, phone, level, bal] of members) {
    insert(db, 'members', { id, name, phone, level, deposit_balance: bal });
  }

  // ---- 训练模式 ----
  const modes = [
    ['tm1', '基础多球', 1200, 120, '高密度送球，固定落点'],
    ['tm2', '截击专项', 900, 100, '网前短球组合'],
    ['tm3', '发球强化', 700, 90, '发球区定点供球'],
    ['tm4', '对打模式', 500, 80, '左右调动，随机落点'],
  ];
  for (const [id, name, bph, fee, note] of modes) {
    insert(db, 'training_modes', { id, name, balls_per_hour: bph, fee_per_hour: fee, note });
  }

  // ---- 预约样例 ----
  // 1) 进行中：15 分钟前开场，已领用 BAT-A / BK-01 / 60 球（训练计时中）
  const bkLive = uid('bk');
  insert(db, 'bookings', {
    id: bkLive, code: 'LIVE01', member_id: 'u1', court_id: 'c1', machine_id: 'm1',
    start_ms: now - 15 * 60e3, end_ms: now + 45 * 60e3, status: 'issued',
    training_mode_id: 'tm1', battery_id: 'bA', basket_id: 'k1', balls_issued: 60,
    balls_returned: null, deposit_held: 200, fee: 120,
    pickup_at: now - 15 * 60e3, returned_at: null, settled_at: null,
    rain_stopped_at: null, charging_ack: 0, late_released_at: null, note: '进行中样例', created_at: now - 30 * 60e3,
  });
  insert(db, 'booking_events', { booking_id: bkLive, type: 'created', detail: JSON.stringify({ code: 'LIVE01' }), at: now - 30 * 60e3 });
  insert(db, 'booking_events', { booking_id: bkLive, type: 'pickup', detail: JSON.stringify({ batteryCode: 'BAT-A', basketCode: 'BK-01', balls: 60 }), at: now - 15 * 60e3 });

  // 2) 待开始：与 LIVE01 在机器/球场维度上构成"尝试冲突"的参照
  const bkNext = uid('bk');
  insert(db, 'bookings', {
    id: bkNext, code: 'NEXT02', member_id: 'u2', court_id: 'c2', machine_id: 'm2',
    start_ms: now + 50 * 60e3, end_ms: now + 110 * 60e3, status: 'confirmed',
    training_mode_id: 'tm2', battery_id: null, basket_id: null, balls_issued: 0,
    balls_returned: null, deposit_held: 200, fee: 100,
    pickup_at: null, returned_at: null, settled_at: null, rain_stopped_at: null,
    charging_ack: 0, late_released_at: null, note: '待领用样例', created_at: now - 10 * 60e3,
  });

  // 3) 迟到释放样例：开场已过 20 分钟（>15 分钟宽限），首次 tick 释放
  const bkLate = uid('bk');
  insert(db, 'bookings', {
    id: bkLate, code: 'LATE03', member_id: 'u3', court_id: 'c3', machine_id: 'm4',
    start_ms: now - 20 * 60e3, end_ms: now + 40 * 60e3, status: 'confirmed',
    training_mode_id: 'tm3', battery_id: null, basket_id: null, balls_issued: 0,
    balls_returned: null, deposit_held: 200, fee: 90,
    pickup_at: null, returned_at: null, settled_at: null, rain_stopped_at: null,
    charging_ack: 0, late_released_at: null, note: '将被迟到释放', created_at: now - 60 * 60e3,
  });

  // 4) 球数短缺样例：12 分钟前刚归还，领 60 还 53，短缺 7 颗 → ¥40 扣款待经理复核；BAT-B 充电中
  const bkShort = uid('bk');
  insert(db, 'bookings', {
    id: bkShort, code: 'SHORT4', member_id: 'u4', court_id: 'c2', machine_id: 'm2',
    start_ms: now - 72 * 60e3, end_ms: now - 12 * 60e3, status: 'returned',
    training_mode_id: 'tm1', battery_id: 'bB', basket_id: 'k2', balls_issued: 60,
    balls_returned: 53, deposit_held: 200, fee: 120,
    pickup_at: now - 72 * 60e3, returned_at: now - 12 * 60e3, settled_at: null,
    rain_stopped_at: null, charging_ack: 1, late_released_at: null, note: '短缺待复核', created_at: now - 90 * 60e3,
  });
  insert(db, 'deductions', {
    id: uid('ded'), booking_id: bkShort, reason_code: 'balls_short', amount: (60 - 53 - constants.BALL_TOLERANCE) * constants.BALL_PRICE,
    detail: `短缺 7 颗球（含 ${constants.BALL_TOLERANCE} 颗合理损耗）`, status: 'proposed',
    proposed_at: now - 12 * 60e3, confirmed_at: null, manager: null, idem_key: `${bkShort}:balls_short`, payment_ref: null,
  });

  // 5) 雨停样例：雨天提前归还，按实际时长折算费用，可直接结单
  const bkRain = uid('bk');
  const rainStart = now - 210 * 60e3, rainPickup = now - 200 * 60e3, rainReturn = now - 165 * 60e3;
  insert(db, 'bookings', {
    id: bkRain, code: 'RAIN05', member_id: 'u2', court_id: 'c3', machine_id: 'm4',
    start_ms: rainStart, end_ms: now - 120 * 60e3, status: 'rain_stopped',
    training_mode_id: 'tm4', battery_id: 'bC', basket_id: 'k3', balls_issued: 48,
    balls_returned: 48, deposit_held: 200,
    fee: Math.round(80 * ((rainReturn - rainPickup) / 3600e3)),
    pickup_at: rainPickup, returned_at: rainReturn, settled_at: null,
    rain_stopped_at: rainReturn, charging_ack: 1, late_released_at: null, note: '雨天停场样例', created_at: rainStart,
  });
  // bC 已充完 → ready；k3 已回收 → available（上面按 ready/available 初始化）

  // 6) 已结单历史样例
  const bkDone = uid('bk');
  insert(db, 'bookings', {
    id: bkDone, code: 'DONE06', member_id: 'u1', court_id: 'c1', machine_id: 'm1',
    start_ms: now - 300 * 60e3, end_ms: now - 240 * 60e3, status: 'settled',
    training_mode_id: 'tm2', battery_id: null, basket_id: 'k4', balls_issued: 60,
    balls_returned: 59, deposit_held: 200, fee: 100,
    pickup_at: now - 300 * 60e3, returned_at: now - 242 * 60e3, settled_at: now - 240 * 60e3,
    rain_stopped_at: null, charging_ack: 1, late_released_at: null, note: null, created_at: now - 320 * 60e3,
  });

  // ---- 设备照片（本地目录占位 SVG）----
  for (const [id, code] of machines) {
    const f = writePlaceholderPhoto(photoDir, 'machine', code, ['#9e4a36', '#3a6b4f']);
    svc.addPhoto('machine', id, f, '机身正面存档');
  }
  for (const code of ['BAT-A', 'BAT-B', 'BAT-C', 'BAT-D']) {
    const id = { 'BAT-A': 'bA', 'BAT-B': 'bB', 'BAT-C': 'bC', 'BAT-D': 'bD' }[code];
    const f = writePlaceholderPhoto(photoDir, 'battery', code, ['#3a6b4f', '#9e4a36']);
    svc.addPhoto('battery', id, f, '电池标签照片');
  }

  // ---- 天气脚本：启动 20 秒后下雨 60 秒（演示雨停挂旗/摘旗）----
  svc.weather.setBase(now);
  svc.weather.setScript([
    { startOffset: 20e3, endOffset: 80e3, condition: 'rain', temp: 19, label: '中雨' },
  ]);

  // 持久化演示时钟锚点与天气脚本，重启后沿用同一条演示时间轴
  insert(db, 'app_meta', { key: 'demo_clock_real', value: String(bootReal) });
  insert(db, 'app_meta', { key: 'demo_clock_demo', value: String(now) });
  insert(db, 'app_meta', { key: 'weather_base', value: String(now) });
  insert(db, 'app_meta', { key: 'weather_script', value: JSON.stringify([
    { startOffset: 20e3, endOffset: 80e3, condition: 'rain', temp: 19, label: '中雨' },
  ]) });

  svc.audit('seed', 'seed.done', {
    samples: ['进行中 LIVE01', '待领用 NEXT02', '迟到释放 LATE03', '球数短缺 SHORT4', '雨停 RAIN05', '已结单 DONE06', '维修 PM-103', '充电 BAT-B'],
  });

  return {
    db,
    svc,
    ids: { live: bkLive, next: bkNext, late: bkLate, short: bkShort, rain: bkRain, done: bkDone },
  };
}

module.exports = { seed };
