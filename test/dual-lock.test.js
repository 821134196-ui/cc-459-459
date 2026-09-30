'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { makeContext, mustFail } = require('./helpers');

// 资源双重锁定：两个订单不能占用同一球场或同一机器的重叠时段
describe('资源双重锁定（球场 + 发球机）', () => {
  test('成功预约在事务内同时锁定球场与发球机', () => {
    const { svc, T0 } = makeContext();
    const b = svc.createBooking({ memberId: 'u1', courtId: 'c1', machineId: 'm1', modeId: 'tm1', startMs: T0, endMs: T0 + 3600e3 });
    assert.strictEqual(b.status, 'confirmed');
    assert.strictEqual(b.court_id, 'c1');
    assert.strictEqual(b.machine_id, 'm1');
  });

  test('同一球场同时段、不同机器 → 球场冲突，拒绝', () => {
    const { svc, T0 } = makeContext();
    svc.createBooking({ memberId: 'u1', courtId: 'c1', machineId: 'm1', modeId: 'tm1', startMs: T0, endMs: T0 + 3600e3 });
    const e = mustFail(() => svc.createBooking({ memberId: 'u2', courtId: 'c1', machineId: 'm2', modeId: 'tm1', startMs: T0, endMs: T0 + 3600e3 }), 'court_conflict');
    assert.deepStrictEqual(e.conflicts.length >= 1, true);
  });

  test('不同球场、同一发球机同时段 → 机器冲突，拒绝', () => {
    const { svc, T0 } = makeContext();
    svc.createBooking({ memberId: 'u1', courtId: 'c1', machineId: 'm1', modeId: 'tm1', startMs: T0, endMs: T0 + 3600e3 });
    mustFail(() => svc.createBooking({ memberId: 'u2', courtId: 'c2', machineId: 'm1', modeId: 'tm1', startMs: T0, endMs: T0 + 3600e3 }), 'machine_conflict');
  });

  test('边界：首尾相接（前单结束 == 后单开始）不算重叠，两单可共存', () => {
    const { svc, T0 } = makeContext();
    svc.createBooking({ memberId: 'u1', courtId: 'c1', machineId: 'm1', modeId: 'tm1', startMs: T0, endMs: T0 + 3600e3 });
    const b2 = svc.createBooking({ memberId: 'u2', courtId: 'c1', machineId: 'm1', modeId: 'tm1', startMs: T0 + 3600e3, endMs: T0 + 7200e3 });
    assert.ok(b2.id);
  });

  test('边界：仅 1 分钟重叠也算冲突', () => {
    const { svc, T0 } = makeContext();
    svc.createBooking({ memberId: 'u1', courtId: 'c1', machineId: 'm1', modeId: 'tm1', startMs: T0, endMs: T0 + 3600e3 });
    mustFail(() => svc.createBooking({ memberId: 'u2', courtId: 'c1', machineId: 'm2', modeId: 'tm1', startMs: T0 + 3599e3, endMs: T0 + 5400e3 }), 'court_conflict');
  });

  test('已释放/已结单的订单不再占锁，资源可再分配', () => {
    const { svc, T0 } = makeContext();
    const b = svc.createBooking({ memberId: 'u1', courtId: 'c1', machineId: 'm1', modeId: 'tm1', startMs: T0, endMs: T0 + 3600e3 });
    svc.cancelBooking(b.id, 'staff');
    const again = svc.createBooking({ memberId: 'u2', courtId: 'c1', machineId: 'm1', modeId: 'tm1', startMs: T0, endMs: T0 + 3600e3 });
    assert.ok(again.id);
  });

  test('维修中的机器不可预约', () => {
    const { svc, T0 } = makeContext();
    mustFail(() => svc.createBooking({ memberId: 'u1', courtId: 'c1', machineId: 'm3', modeId: 'tm1', startMs: T0 + 3600e3, endMs: T0 + 7200e3 }), 'machine_maintenance');
  });

  test('雨天停场的球场不可预约', () => {
    const { svc, T0 } = makeContext();
    svc.setCourtRain('c1', true);
    mustFail(() => svc.createBooking({ memberId: 'u1', courtId: 'c1', machineId: 'm1', modeId: 'tm1', startMs: T0, endMs: T0 + 3600e3 }), 'rain_suspended');
  });
});
