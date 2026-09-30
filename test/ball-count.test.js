'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { makeContext, mustFail } = require('./helpers');

function issued(svc, balls = 60) {
  const b = svc.createBooking({ memberId: 'u1', courtId: 'c1', machineId: 'm1', modeId: 'tm1',
    startMs: 1_700_000_000_000, endMs: 1_700_000_000_000 + 3600e3 });
  svc.pickup(b.id, { batteryId: 'bA', basketId: 'k1', balls });
  return b.id;
}

describe('球数清点差异', () => {
  test('数量一致：无扣款，经理无需复核即可结单', () => {
    const { svc } = makeContext();
    const id = issued(svc, 60);
    const r = svc.returnEquipment(id, { ballsReturned: 60, batteryPct: 40 });
    assert.strictEqual(r.balls_returned, 60);
    assert.strictEqual(r.deductions.length, 0);
    const settled = svc.settle(id);
    assert.strictEqual(settled.status, 'settled');
  });

  test('短缺在合理损耗（2 颗）内：不生成扣款', () => {
    const { svc } = makeContext();
    const id = issued(svc, 60);
    const r = svc.returnEquipment(id, { ballsReturned: 58, batteryPct: 40 });
    assert.strictEqual(r.deductions.length, 0);
  });

  test('短缺超出损耗：按超出部分生成扣款建议，结单被阻断', () => {
    const { svc } = makeContext();
    const id = issued(svc, 60);
    const r = svc.returnEquipment(id, { ballsReturned: 53, batteryPct: 40 }); // 短缺 7，赔 5 颗
    assert.strictEqual(r.deductions.length, 1);
    assert.strictEqual(r.deductions[0].reason_code, 'balls_short');
    assert.strictEqual(r.deductions[0].amount, (7 - 2) * 8); // 40
    assert.strictEqual(r.deductions[0].status, 'proposed');
    mustFail(() => svc.settle(id), 'deduction_pending');
  });

  test('短缺 3 颗：仅 1 颗计赔（¥8）', () => {
    const { svc } = makeContext();
    const id = issued(svc, 60);
    const r = svc.returnEquipment(id, { ballsReturned: 57, batteryPct: 40 });
    assert.strictEqual(r.deductions[0].amount, 8);
  });

  test('归还数量不能为负', () => {
    const { svc } = makeContext();
    const id = issued(svc, 60);
    mustFail(() => svc.returnEquipment(id, { ballsReturned: -1, batteryPct: 40 }), 'bad_balls');
  });

  test('归还同时回收球筐并将电池置为充电中', () => {
    const { svc, db } = makeContext();
    const id = issued(svc, 60);
    svc.returnEquipment(id, { ballsReturned: 60, batteryPct: 33 });
    const basket = db.prepare(`SELECT * FROM baskets WHERE id='k1'`).get();
    const battery = db.prepare(`SELECT * FROM batteries WHERE id='bA'`).get();
    assert.strictEqual(basket.status, 'available');
    assert.strictEqual(battery.status, 'charging');
    assert.strictEqual(battery.charge_pct, 33);
  });

  test('未完成充电确认/清点不可结单', () => {
    const { svc } = makeContext();
    const b = svc.createBooking({ memberId: 'u1', courtId: 'c1', machineId: 'm1', modeId: 'tm1',
      startMs: 1_700_000_000_000, endMs: 1_700_000_000_000 + 3600e3 });
    // 未领用未归还
    mustFail(() => svc.settle(b.id), 'bad_status');
  });

  test('雨天提前归还：费用按实际训练时长折算', () => {
    const { svc, advance } = makeContext();
    const id = issued(svc, 60);
    advance(18 * 60e3); // 实际训练 18 分钟
    const r = svc.returnEquipment(id, { ballsReturned: 60, rain: true, batteryPct: 40 });
    assert.strictEqual(r.status, 'rain_stopped');
    assert.strictEqual(r.fee, 30); // 100/时 × 0.3 时
  });
});
