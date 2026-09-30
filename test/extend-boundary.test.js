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

// 临时续场：必须重新检查球场与发球机的后续预约
describe('临时续场边界', () => {
  test('无后续预约：续场 60 分钟，结束时间与费用更新', () => {
    const { svc } = makeContext();
    const b = book(svc);
    const ext = svc.extendBooking(b.id, 60);
    assert.strictEqual(ext.end_ms, b.end_ms + 3600e3);
    assert.strictEqual(ext.fee, 200); // 100/时 × 2 小时
  });

  test('续场与后续"球场"预约冲突 → 拒绝，结束时间不变', () => {
    const { svc, T0 } = makeContext();
    const b = book(svc);
    // 后续订单与本单首尾相接（可正常创建），但续场 30 分钟即会与其重叠：同球场、不同机器
    svc.createBooking({ memberId: 'u2', courtId: 'c1', machineId: 'm2', modeId: 'tm1',
      startMs: b.end_ms, endMs: b.end_ms + 60 * 60e3 });
    mustFail(() => svc.extendBooking(b.id, 30), 'court_conflict');
    const reloaded = svc.getBooking(b.id);
    assert.strictEqual(reloaded.end_ms, b.end_ms);
  });

  test('续场与后续"发球机"预约冲突（不同球场）→ 同样拒绝', () => {
    const { svc, T0 } = makeContext();
    const b = book(svc);
    svc.createBooking({ memberId: 'u2', courtId: 'c2', machineId: 'm1', modeId: 'tm1',
      startMs: b.end_ms, endMs: b.end_ms + 60 * 60e3 });
    mustFail(() => svc.extendBooking(b.id, 30), 'machine_conflict');
  });

  test('边界：后续预约恰在续场后新结束点开始 → 首尾相接，允许', () => {
    const { svc } = makeContext();
    const b = book(svc);
    const newEnd = b.end_ms + 30 * 60e3;
    svc.createBooking({ memberId: 'u2', courtId: 'c1', machineId: 'm1', modeId: 'tm1',
      startMs: newEnd, endMs: newEnd + 3600e3 });
    const ext = svc.extendBooking(b.id, 30);
    assert.strictEqual(ext.end_ms, newEnd);
  });

  test('进行中（已领用）订单也可续场', () => {
    const { svc } = makeContext();
    const b = book(svc);
    svc.pickup(b.id, { batteryId: 'bA', basketId: 'k1', balls: 60 });
    const ext = svc.extendBooking(b.id, 30);
    assert.strictEqual(ext.status, 'issued');
    assert.strictEqual(ext.end_ms, b.end_ms + 1800e3);
  });

  test('已结单订单不可续场', () => {
    const { svc, advance } = makeContext();
    const b = book(svc);
    svc.pickup(b.id, { batteryId: 'bA', basketId: 'k1', balls: 60 });
    advance(3600e3);
    svc.returnEquipment(b.id, { ballsReturned: 60, batteryPct: 40 });
    svc.settle(b.id);
    mustFail(() => svc.extendBooking(b.id, 30), 'bad_status');
  });

  test('续场期间机器转入维修 → 续场被阻断', () => {
    const { svc } = makeContext();
    const b = book(svc);
    svc.reportRepair('m1', { reason: '异响' });
    mustFail(() => svc.extendBooking(b.id, 30), 'machine_maintenance');
  });
});
