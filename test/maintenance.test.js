'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { makeContext, mustFail } = require('./helpers');

function book(svc, overrides = {}) {
  return svc.createBooking({
    memberId: 'u1', courtId: 'c1', machineId: 'm1', modeId: 'tm1',
    startMs: 1_700_000_000_000, endMs: 1_700_000_000_000 + 3600e3, ...overrides,
  });
}

describe('维修阻断与充电不可分配', () => {
  test('预约时直接选择维修机器被拒', () => {
    const { svc, T0 } = makeContext();
    mustFail(() => svc.createBooking({ memberId: 'u1', courtId: 'c2', machineId: 'm3', modeId: 'tm1',
      startMs: T0, endMs: T0 + 3600e3 }), 'machine_maintenance');
  });

  test('已预约未领用：机器报维修后，领用被阻断', () => {
    const { svc } = makeContext();
    const b = book(svc);
    svc.reportRepair('m1', { reason: '卡球严重' });
    mustFail(() => svc.pickup(b.id, { batteryId: 'bA', basketId: 'k1', balls: 60 }), 'machine_maintenance');
  });

  test('维修登记后机器立即不可用于新预约，修复后恢复', () => {
    const { svc, T0 } = makeContext();
    const rep = svc.reportRepair('m2', { reason: '异响' });
    mustFail(() => svc.createBooking({ memberId: 'u2', courtId: 'c2', machineId: 'm2', modeId: 'tm1',
      startMs: T0, endMs: T0 + 3600e3 }), 'machine_maintenance');
    svc.resolveRepair(rep.id, '经理');
    const b2 = svc.createBooking({ memberId: 'u2', courtId: 'c2', machineId: 'm2', modeId: 'tm1',
      startMs: T0, endMs: T0 + 3600e3 });
    assert.ok(b2.id);
  });

  test('充电未完成的电池不可分配：指定时报错，自动选择也跳过', () => {
    const { svc } = makeContext();
    const b = book(svc);
    mustFail(() => svc.pickup(b.id, { batteryId: 'bB', basketId: 'k1', balls: 60 }), 'battery_not_ready');
    // 自动分配选到满电 bA，而不是充电中的 bB
    const issued = svc.pickup(b.id, { basketId: 'k1', balls: 60 });
    assert.strictEqual(issued.battery_id, 'bA');
  });

  test('低于领用门槛电量（BAT-C 35%）不可指定分配', () => {
    const { svc } = makeContext();
    const b = book(svc);
    mustFail(() => svc.pickup(b.id, { batteryId: 'bC', basketId: 'k1', balls: 60 }), 'battery_low');
  });

  test('电池掉电更换：旧电池转充电，只能换入 ready 满电电池', () => {
    const { svc } = makeContext();
    const b = book(svc);
    svc.pickup(b.id, { batteryId: 'bA', basketId: 'k1', balls: 60 });
    const r = svc.swapBattery(b.id, 'bD');
    assert.strictEqual(r.battery_id, 'bD');
    const old = svc.get(`SELECT * FROM batteries WHERE id='bA'`);
    assert.strictEqual(old.status, 'charging');
    // 不能换入正在充电的电池
    mustFail(() => svc.swapBattery(b.id, 'bB'), 'battery_not_ready');
  });

  test('卡球无法清除 → 自动转维修；已进行的订单仍可归还', () => {
    const { svc } = makeContext();
    const b = book(svc);
    svc.pickup(b.id, { batteryId: 'bA', basketId: 'k1', balls: 60 });
    svc.reportJam(b.id, false, '出球口完全卡死');
    const m = svc.get(`SELECT * FROM machines WHERE id='m1'`);
    assert.strictEqual(m.status, 'maintenance');
    const r = svc.returnEquipment(b.id, { ballsReturned: 60, batteryPct: 20 });
    assert.strictEqual(r.status, 'returned');
  });

  test('调度器：充电到期自动置回 ready 并充满', () => {
    const { svc, advance, db } = makeContext();
    assert.strictEqual(db.prepare(`SELECT status FROM batteries WHERE id='bB'`).get().status, 'charging');
    advance(46 * 60e3); // 超过 45 分钟充电时长
    const out = svc.tick();
    assert.ok(out.chargesCompleted.includes('BAT-B'));
    const bB = db.prepare(`SELECT * FROM batteries WHERE id='bB'`).get();
    assert.strictEqual(bB.status, 'ready');
    assert.strictEqual(bB.charge_pct, 100);
  });

  test('调度器：开场超过 15 分钟宽限仍未领用 → 迟到释放并解锁资源', () => {
    const { svc, T0, advance } = makeContext();
    const b = svc.createBooking({ memberId: 'u1', courtId: 'c1', machineId: 'm1', modeId: 'tm1',
      startMs: T0, endMs: T0 + 3600e3 });
    advance(14 * 60e3 + 59e3);
    assert.deepStrictEqual(svc.tick().lateReleased, []);
    advance(2e3); // 到 15 分钟
    const out = svc.tick();
    assert.ok(out.lateReleased.length >= 1);
    assert.strictEqual(svc.getBooking(b.id).status, 'released');
    // 资源已释放：同球场同机器同时段可再预约（时间已前移，直接验证占锁状态为空）
    const clashes = svc.findConflicts('court', 'c1', T0, T0 + 3600e3);
    assert.strictEqual(clashes.length, 0);
  });
});
