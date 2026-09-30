'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { makeContext, mustFail, insert, uid } = require('./helpers');

function returnedOrder(svc, returnedBalls = 50) {
  const b = svc.createBooking({ memberId: 'u1', courtId: 'c1', machineId: 'm1', modeId: 'tm1',
    startMs: 1_700_000_000_000, endMs: 1_700_000_000_000 + 3600e3 });
  svc.pickup(b.id, { batteryId: 'bA', basketId: 'k1', balls: 60 });
  svc.returnEquipment(b.id, { ballsReturned: returnedBalls, batteryPct: 40 });
  return b.id;
}

describe('押金扣款经理复核与幂等', () => {
  test('短缺后自动生成唯一扣款建议（同订单同原因只保留一条）', () => {
    const { svc } = makeContext();
    const id = returnedOrder(svc, 50); // 短缺 10，自动生成
    svc.proposeDeduction(id, 'balls_short', 999, '重复发起不应产生第二条');
    const b = svc.bookingDetail(id);
    const ballDeds = b.deductions.filter((d) => d.reason_code === 'balls_short');
    assert.strictEqual(ballDeds.length, 1);
    // 金额以先创建的自动建议为准
    assert.strictEqual(ballDeds[0].amount, (10 - 2) * 8);
  });

  test('非经理不能确认扣款', () => {
    const { svc } = makeContext();
    const id = returnedOrder(svc, 50);
    const ded = svc.bookingDetail(id).deductions[0];
    mustFail(() => svc.confirmDeduction(ded.id, null), 'forbidden');
  });

  test('缺少归还清点记录的订单不能确认扣款', () => {
    const { svc, T0 } = makeContext();
    const b = svc.createBooking({ memberId: 'u1', courtId: 'c1', machineId: 'm1', modeId: 'tm1',
      startMs: T0, endMs: T0 + 3600e3 });
    // 直接在数据层造一条扣款，模拟绕过流程
    const id = uid('ded');
    insert(svc.db, 'deductions', {
      id, booking_id: b.id, reason_code: 'equipment_damage', amount: 100,
      detail: '人为损坏', status: 'proposed', proposed_at: T0, confirmed_at: null,
      manager: null, idem_key: `${b.id}:equipment_damage`, payment_ref: null,
    });
    mustFail(() => svc.confirmDeduction(id, '经理'), 'no_return_record');
  });

  test('经理确认后押金扣减，待复核清零才可结单', () => {
    const { svc } = makeContext();
    const id = returnedOrder(svc, 50); // 赔 8 颗 ×8 = 64
    const ded = svc.bookingDetail(id).deductions[0];
    const before = svc.get(`SELECT deposit_balance FROM members WHERE id='u1'`).deposit_balance;
    const r = svc.confirmDeduction(ded.id, '经理·周');
    assert.strictEqual(r.deduction.status, 'confirmed');
    assert.strictEqual(r.deduction.manager, '经理·周');
    assert.ok(r.deduction.payment_ref);
    const after = svc.get(`SELECT deposit_balance FROM members WHERE id='u1'`).deposit_balance;
    assert.strictEqual(after, before - 64);
    const settled = svc.settle(id);
    assert.strictEqual(settled.status, 'settled');
  });

  test('幂等：重复确认不重复扣款，余额与支付流水保持不变', () => {
    const { svc, payment } = makeContext();
    const id = returnedOrder(svc, 50);
    const ded = svc.bookingDetail(id).deductions[0];
    const r1 = svc.confirmDeduction(ded.id, '经理·周');
    const bal1 = svc.get(`SELECT deposit_balance FROM members WHERE id='u1'`).deposit_balance;
    const ref1 = r1.deduction.payment_ref;

    const r2 = svc.confirmDeduction(ded.id, '经理·周');
    const r3 = svc.confirmDeduction(ded.id, '经理·周');
    const bal3 = svc.get(`SELECT deposit_balance FROM members WHERE id='u1'`).deposit_balance;

    assert.strictEqual(r2.idempotent, true);
    assert.strictEqual(r3.idempotent, true);
    assert.strictEqual(bal3, bal1);               // 余额只扣一次
    assert.strictEqual(r2.deduction.payment_ref, ref1);
    const depositCalls = payment.calls.filter((c) => c.kind === 'deposit_deduction');
    assert.strictEqual(depositCalls.length, 1);  // 支付网关只收到一次请求
  });

  test('结单费用支付同样幂等（重复 settle 在已结单后被状态拦截，幂等键不产生多笔流水）', () => {
    const { svc, payment } = makeContext();
    const id = returnedOrder(svc, 60);
    const s1 = svc.settle(id);
    assert.strictEqual(s1.status, 'settled');
    mustFail(() => svc.settle(id), 'bad_status');
    const feeCalls = payment.calls.filter((c) => c.kind === 'fee');
    assert.strictEqual(feeCalls.length, 1);
  });

  test('经理驳回后不扣押金，订单可以结单', () => {
    const { svc } = makeContext();
    const id = returnedOrder(svc, 50);
    const before = svc.get(`SELECT deposit_balance FROM members WHERE id='u1'`).deposit_balance;
    const ded = svc.bookingDetail(id).deductions[0];
    svc.rejectDeduction(ded.id, '经理·周');
    assert.strictEqual(svc.get(`SELECT deposit_balance FROM members WHERE id='u1'`).deposit_balance, before);
    const settled = svc.settle(id);
    assert.strictEqual(settled.status, 'settled');
  });

  test('刮伤归还自动生成 ¥50 刮伤扣款建议，与球数短缺相互独立', () => {
    const { svc } = makeContext();
    const b = svc.createBooking({ memberId: 'u1', courtId: 'c1', machineId: 'm1', modeId: 'tm1',
      startMs: 1_700_000_000_000, endMs: 1_700_000_000_000 + 3600e3 });
    svc.pickup(b.id, { batteryId: 'bA', basketId: 'k1', balls: 60 });
    svc.returnEquipment(b.id, { ballsReturned: 50, batteryPct: 40, scratch: true, scratchNote: '球筐边沿掉漆' });
    const codes = svc.bookingDetail(b.id).deductions.map((d) => d.reason_code).sort();
    assert.deepStrictEqual(codes, ['balls_short', 'scratch']);
  });
});
