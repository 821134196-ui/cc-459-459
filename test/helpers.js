'use strict';

const { openDb } = require('../src/db');
const { ClubService, WeatherAdapter, PaymentAdapter } = require('../src/service');
const { uid } = require('../src/util');

function insert(db, table, row) {
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
    .run(...cols.map((c) => row[c]));
}

// 构造内存库 + 可控时钟的最小演示目录
function makeContext() {
  const db = openDb(':memory:');
  let now = 1_700_000_000_000; // 固定基准，避免依赖真实时间
  const payment = new PaymentAdapter();
  const weather = new WeatherAdapter();
  const svc = new ClubService(db, {
    payment,
    weather,
    now: () => now,
    photoDir: '/tmp/club-test-photos',
  });
  const setNow = (ms) => { now = ms; };
  const advance = (ms) => { now += ms; };

  // 球场
  insert(db, 'courts', { id: 'c1', name: '1 号场', surface: '硬地', status: 'active', rain_suspended: 0 });
  insert(db, 'courts', { id: 'c2', name: '2 号场', surface: '硬地', status: 'active', rain_suspended: 0 });

  // 发球机（m3 维修中）
  insert(db, 'machines', { id: 'm1', code: 'PM-101', model: 'Pro', status: 'ok', note: null });
  insert(db, 'machines', { id: 'm2', code: 'PM-102', model: 'Pro', status: 'ok', note: null });
  insert(db, 'machines', { id: 'm3', code: 'PM-103', model: 'Lite', status: 'maintenance', note: '卡球' });

  // 电池：bA ready 满电；bB 充电中；bC ready 低电；bD ready 满电
  insert(db, 'batteries', { id: 'bA', code: 'BAT-A', status: 'ready', charge_pct: 100, charge_started_at: null, charging_until: null, swap_count: 0 });
  insert(db, 'batteries', { id: 'bB', code: 'BAT-B', status: 'charging', charge_pct: 30, charge_started_at: now, charging_until: now + 45 * 60e3, swap_count: 0 });
  insert(db, 'batteries', { id: 'bC', code: 'BAT-C', status: 'ready', charge_pct: 35, charge_started_at: null, charging_until: null, swap_count: 0 });
  insert(db, 'batteries', { id: 'bD', code: 'BAT-D', status: 'ready', charge_pct: 96, charge_started_at: null, charging_until: null, swap_count: 0 });

  // 球筐
  insert(db, 'baskets', { id: 'k1', code: 'BK-01', capacity: 60, status: 'available' });
  insert(db, 'baskets', { id: 'k2', code: 'BK-02', capacity: 60, status: 'available' });
  insert(db, 'baskets', { id: 'k3', code: 'BK-03', capacity: 48, status: 'available' });

  // 会员
  insert(db, 'members', { id: 'u1', name: '测试会员甲', phone: '1', level: '3.0', deposit_balance: 500 });
  insert(db, 'members', { id: 'u2', name: '测试会员乙', phone: '2', level: '3.5', deposit_balance: 500 });

  // 训练模式
  insert(db, 'training_modes', { id: 'tm1', name: '基础多球', balls_per_hour: 1200, fee_per_hour: 100, note: '' });

  return { db, svc, payment, weather, setNow, advance, now: () => now, T0: 1_700_000_000_000 };
}

function mustFail(promiseOrFn, code) {
  const run = typeof promiseOrFn === 'function' ? promiseOrFn : () => promiseOrFn;
  try {
    const r = run();
    if (r && typeof r.then === 'function') {
      return r.then(
        () => { throw new Error('应当抛错但成功了'); },
        (e) => { if (code && e.code !== code) throw new Error(`错误码不符：期望 ${code}，实际 ${e.code} (${e.message})`); return e; }
      );
    }
    throw new Error('应当抛错但成功了');
  } catch (e) {
    if (code && e.code !== code) throw new Error(`错误码不符：期望 ${code}，实际 ${e.code} (${e.message})`);
    return e;
  }
}

module.exports = { makeContext, mustFail, insert, uid };
