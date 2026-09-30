'use strict';

const { LOCKING_STATUSES } = require('./db');
const { uid, overlap, iso } = require('./util');

// ---- 业务常量（演示尺度，方便观察调度器）----
const LATE_GRACE_MS = 15 * 60e3;        // 开场后 15 分钟未领用 → 迟到释放
const CHARGE_MS = 45 * 60e3;            // 电池充电时长
const MIN_ISSUE_CHARGE = 80;            // 领用电池最低电量
const BALL_TOLERANCE = 2;               // 球数合理损耗
const BALL_PRICE = 8;                   // 每颗短缺球赔偿（元）
const DEPOSIT_HOLD = 200;               // 每单押金预冻
const SCRATCH_FEE = 50;                 // 刮伤扣款建议
const SLOT_STEP_MIN = 30;

class DomainError extends Error {
  constructor(code, message, info = {}) {
    super(message);
    this.code = code;
    Object.assign(this, info);
  }
}

// ---------------- 模拟适配器 ----------------

// 天气：按时间轴脚本返回，便于种子制造雨停样例
class WeatherAdapter {
  constructor(schedule = []) {
    // [{startOffset, endOffset, condition}] 偏移相对基准时间
    this.schedule = schedule;
    this.base = null;
  }
  setBase(ms) {
    this.base = ms;
  }
  setScript(schedule) {
    this.schedule = schedule;
  }
  getWeather(now = Date.now()) {
    if (this.base == null) return { condition: 'sunny', temp: 26, label: '晴' };
    const off = now - this.base;
    const hit = this.schedule.find((s) => off >= s.startOffset && off < s.endOffset);
    if (hit) return { condition: hit.condition, temp: hit.temp || 22, label: hit.label };
    return { condition: 'sunny', temp: 26, label: '晴' };
  }
  isRaining(now = Date.now()) {
    return this.getWeather(now).condition === 'rain';
  }
}

// 支付：内存幂等键，模拟成功/余额不足
class PaymentAdapter {
  constructor() {
    this.calls = [];
    this.failNext = false;
  }
  pay({ memberId, amount, idemKey, kind }) {
    const exist = this.calls.find((c) => c.idemKey === idemKey);
    if (exist) return { ok: true, ref: exist.ref, idempotent: true };
    if (this.failNext) {
      this.failNext = false;
      return { ok: false, reason: 'payment_gateway_timeout' };
    }
    const ref = `PAY_${uid('').slice(2).toUpperCase()}`;
    this.calls.push({ memberId, amount, idemKey, kind, ref, at: Date.now() });
    return { ok: true, ref };
  }
}

// ---------------- 领域服务 ----------------
class ClubService {
  constructor(db, opts = {}) {
    this.db = db;
    this.weather = opts.weather || new WeatherAdapter();
    this.payment = opts.payment || new PaymentAdapter();
    this.now = opts.now || (() => Date.now());
    this.photoDir = opts.photoDir || null;
  }

  get t() { return this.now(); }

  logEvent(bookingId, type, detail = {}) {
    this.db.prepare(
      `INSERT INTO booking_events (booking_id, type, detail, at) VALUES (?,?,?,?)`
    ).run(bookingId, type, JSON.stringify(detail), this.t);
  }

  audit(actor, action, detail = {}) {
    this.db.prepare(
      `INSERT INTO audit_log (at, actor, action, detail) VALUES (?,?,?,?)`
    ).run(this.t, actor || 'system', action, JSON.stringify(detail));
  }

  // ---- 基础查询 ----
  list(sql, ...args) {
    return this.db.prepare(sql).all(...args);
  }
  get(sql, ...args) {
    return this.db.prepare(sql).get(...args);
  }

  getBooking(id) {
    const b = this.get(`SELECT * FROM bookings WHERE id = ?`, id);
    if (!b) throw new DomainError('not_found', '预约不存在', { id });
    return b;
  }

  bookingsForDay(dayStartMs) {
    const end = dayStartMs + 24 * 3600e3;
    const rows = this.list(
      `SELECT * FROM bookings WHERE start_ms < ? AND end_ms > ? ORDER BY start_ms`,
      end, dayStartMs
    );
    return rows.map((b) => this._decorate(b));
  }

  _decorate(b) {
    b = { ...b };
    b.court = this.get(`SELECT * FROM courts WHERE id=?`, b.court_id);
    b.machine = this.get(`SELECT * FROM machines WHERE id=?`, b.machine_id);
    b.member = this.get(`SELECT id,name,phone,level,deposit_balance FROM members WHERE id=?`, b.member_id);
    b.mode = b.training_mode_id ? this.get(`SELECT * FROM training_modes WHERE id=?`, b.training_mode_id) : null;
    b.battery = b.battery_id ? this.get(`SELECT * FROM batteries WHERE id=?`, b.battery_id) : null;
    b.basket = b.basket_id ? this.get(`SELECT * FROM baskets WHERE id=?`, b.basket_id) : null;
    b.deductions = this.list(`SELECT * FROM deductions WHERE booking_id=? ORDER BY proposed_at`, b.id);
    return b;
  }

  bookingDetail(id) {
    const b = this._decorate(this.getBooking(id));
    b.events = this.list(`SELECT * FROM booking_events WHERE booking_id=? ORDER BY id`, id)
      .map((e) => ({ ...e, detail: safeJson(e.detail) }));
    b.incidents = this.list(`SELECT * FROM incidents WHERE booking_id=? ORDER BY at`, id);
    return b;
  }

  // 与某资源在 [start,end) 冲突的、仍占锁的预约（可排除自身）
  findConflicts(resource, resourceId, start, end, excludeId = null) {
    const col = resource === 'court' ? 'court_id' : 'machine_id';
    return this.list(
      `SELECT * FROM bookings
       WHERE ${col} = ? AND id != COALESCE(?, '')
         AND status IN (${LOCKING_STATUSES.map(() => '?').join(',')})
       ORDER BY start_ms`,
      resourceId, excludeId, ...LOCKING_STATUSES
    ).filter((b) => overlap(start, end, b.start_ms, b.end_ms));
  }

  // ---- 预约创建：同一事务内同时检查并锁定球场+发球机 ----
  createBooking(input) {
    const {
      memberId, courtId, machineId, modeId,
      startMs, endMs,
    } = input;
    if (!endMs || endMs <= startMs) throw new DomainError('bad_time', '结束时间必须晚于开始时间');

    const member = this.get(`SELECT * FROM members WHERE id=?`, memberId);
    if (!member) throw new DomainError('not_found', '会员不存在');
    const court = this.get(`SELECT * FROM courts WHERE id=?`, courtId);
    if (!court) throw new DomainError('not_found', '球场不存在');
    const machine = this.get(`SELECT * FROM machines WHERE id=?`, machineId);
    if (!machine) throw new DomainError('not_found', '发球机不存在');
    const mode = modeId ? this.get(`SELECT * FROM training_modes WHERE id=?`, modeId) : null;
    if (modeId && !mode) throw new DomainError('not_found', '训练模式不存在');

    const tx = () => {
      if (court.status !== 'active') throw new DomainError('court_unavailable', '球场已关闭');
      if (court.rain_suspended) throw new DomainError('rain_suspended', '球场因雨天暂停开放');
      if (machine.status === 'maintenance') {
        throw new DomainError('machine_maintenance', `发球机 ${machine.code} 维修中，不可分配`, { machineCode: machine.code });
      }
      const courtClash = this.findConflicts('court', courtId, startMs, endMs);
      if (courtClash.length) {
        throw new DomainError('court_conflict', '该球场时段已被预约', { conflicts: courtClash.map((c) => c.code) });
      }
      const machineClash = this.findConflicts('machine', machineId, startMs, endMs);
      if (machineClash.length) {
        throw new DomainError('machine_conflict', '该发球机时段已被预约', { conflicts: machineClash.map((c) => c.code) });
      }
      if (member.deposit_balance < DEPOSIT_HOLD) {
        throw new DomainError('deposit_low', `押金余额不足，需冻结 ¥${DEPOSIT_HOLD}`);
      }
      const hours = (endMs - startMs) / 3600e3;
      const fee = mode ? Math.round(mode.fee_per_hour * hours) : 0;
      const id = uid('bk');
      const code = `B${new Date(startMs).toISOString().slice(5, 10).replace('-', '')}${String(this.countBookingsDay(startMs) + 1).padStart(2, '0')}`;
      this.db.prepare(
        `INSERT INTO bookings (id, code, member_id, court_id, machine_id, start_ms, end_ms,
           status, training_mode_id, deposit_held, fee, note, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(id, code, memberId, courtId, machineId, startMs, endMs, 'confirmed', modeId || null, DEPOSIT_HOLD, fee, input.note || null, this.t);
      this.logEvent(id, 'created', { code, court: court.name, machine: machine.code, fee });
      return id;
    };
    const id = withTransaction(this.db, tx);
    this.audit(memberId, 'booking.create', { id: id });
    return this.bookingDetail(id);
  }

  countBookingsDay(startMs) {
    const d = new Date(startMs); d.setHours(0, 0, 0, 0);
    const row = this.get(
      `SELECT COUNT(*) c FROM bookings WHERE start_ms >= ? AND start_ms < ?`,
      d.getTime(), d.getTime() + 24 * 3600e3
    );
    return row.c;
  }

  cancelBooking(id, actor) {
    const b = this.getBooking(id);
    if (!['confirmed'].includes(b.status)) throw new DomainError('bad_status', `状态 ${b.status} 不可取消`);
    this.db.prepare(`UPDATE bookings SET status='cancelled' WHERE id=?`).run(id);
    this.logEvent(id, 'cancelled', { actor });
    this.audit(actor, 'booking.cancel', { id });
    return this.bookingDetail(id);
  }

  // ---- 临时续场：重新检查球场与发球机的后续预约 ----
  extendBooking(id, minutes) {
    const b = this.getBooking(id);
    if (!['confirmed', 'issued'].includes(b.status)) {
      throw new DomainError('bad_status', `状态 ${b.status} 不可续场`);
    }
    if (![30, 60, 90, 120].includes(minutes)) {
      throw new DomainError('bad_input', '续场时长须为 30/60/90/120 分钟');
    }
    const newEnd = b.end_ms + minutes * 60e3;
    const tx = () => {
      const machine = this.get(`SELECT * FROM machines WHERE id=?`, b.machine_id);
      if (machine.status === 'maintenance') throw new DomainError('machine_maintenance', '发球机已进入维修');
      const courtClash = this.findConflicts('court', b.court_id, b.start_ms, newEnd, id);
      if (courtClash.length) {
        throw new DomainError('court_conflict', '续场与后续球场预约冲突', { conflicts: courtClash.map((c) => c.code), at: courtClash[0].start_ms });
      }
      const machineClash = this.findConflicts('machine', b.machine_id, b.start_ms, newEnd, id);
      if (machineClash.length) {
        throw new DomainError('machine_conflict', '续场与后续发球机预约冲突', { conflicts: machineClash.map((c) => c.code), at: machineClash[0].start_ms });
      }
      let fee = b.fee;
      if (b.training_mode_id) {
        const mode = this.get(`SELECT * FROM training_modes WHERE id=?`, b.training_mode_id);
        fee = Math.round(mode.fee_per_hour * ((newEnd - b.start_ms) / 3600e3));
      }
      this.db.prepare(`UPDATE bookings SET end_ms=?, fee=? WHERE id=?`).run(newEnd, fee, id);
      return newEnd;
    };
    const end = withTransaction(this.db, tx);
    this.logEvent(id, 'extended', { minutes, newEnd: end });
    return this.bookingDetail(id);
  }

  // ---- 开场领用：电池 + 球筐 + 球数 ----
  pickup(id, opts = {}) {
    const b = this.getBooking(id);
    if (b.status !== 'confirmed') throw new DomainError('bad_status', `状态 ${b.status} 不可领用`);
    if (this.t > b.end_ms) throw new DomainError('expired', '时段已结束，不能领用');

    const tx = () => {
      const machine = this.get(`SELECT * FROM machines WHERE id=?`, b.machine_id);
      if (machine.status === 'maintenance') throw new DomainError('machine_maintenance', '发球机维修中，无法领用');

      // 电池：可指定，否则自动挑电量最高的 ready 电池；充电未完成不可分配
      let battery;
      if (opts.batteryId) {
        battery = this.get(`SELECT * FROM batteries WHERE id=?`, opts.batteryId);
        if (!battery) throw new DomainError('not_found', '电池不存在');
        if (battery.status !== 'ready') throw new DomainError('battery_not_ready', `电池 ${battery.code} ${battery.status === 'charging' ? '充电未完成' : '使用中'}，不可分配`);
      } else {
        battery = this.get(`SELECT * FROM batteries WHERE status='ready' AND charge_pct >= ? ORDER BY charge_pct DESC LIMIT 1`, MIN_ISSUE_CHARGE);
        if (!battery) throw new DomainError('battery_not_ready', '没有电量充足的可用电池');
      }
      if (battery.charge_pct < MIN_ISSUE_CHARGE) {
        throw new DomainError('battery_low', `电池 ${battery.code} 电量 ${battery.charge_pct}%，低于领用标准 ${MIN_ISSUE_CHARGE}%`);
      }

      // 球筐：可指定，否则任选 available
      let basket;
      if (opts.basketId) {
        basket = this.get(`SELECT * FROM baskets WHERE id=?`, opts.basketId);
        if (!basket) throw new DomainError('not_found', '球筐不存在');
        if (basket.status !== 'available') throw new DomainError('basket_busy', `球筐 ${basket.code} 已被领用`);
      } else {
        basket = this.get(`SELECT * FROM baskets WHERE status='available' ORDER BY capacity DESC, code LIMIT 1`);
        if (!basket) throw new DomainError('basket_busy', '没有可用球筐');
      }

      const balls = Number.isInteger(opts.balls) ? opts.balls : basket.capacity;
      if (balls <= 0 || balls > basket.capacity) throw new DomainError('bad_balls', `领用球数须在 1–${basket.capacity}`);

      this.db.prepare(`UPDATE batteries SET status='in_use' WHERE id=?`).run(battery.id);
      this.db.prepare(`UPDATE baskets SET status='in_use' WHERE id=?`).run(basket.id);
      this.db.prepare(
        `UPDATE bookings SET status='issued', battery_id=?, basket_id=?, balls_issued=?, pickup_at=? WHERE id=?`,
      ).run(battery.id, basket.id, balls, this.t, id);
      return { batteryCode: battery.code, basketCode: basket.code, balls };
    };
    const out = withTransaction(this.db, tx);
    this.logEvent(id, 'pickup', out);
    this.audit('staff', 'booking.pickup', { id, ...out });
    return this.bookingDetail(id);
  }

  // ---- 归还清点：归还设备/球筐/散球，电池插入充电 ----
  // rain=true 表示雨天提前停场（按时长折算费用）
  returnEquipment(id, input = {}) {
    const b = this.getBooking(id);
    if (!['issued', 'rain_stopped'].includes(b.status)) {
      throw new DomainError('bad_status', `状态 ${b.status} 不可归还`);
    }
    const ballsReturned = input.ballsReturned;
    if (!Number.isInteger(ballsReturned) || ballsReturned < 0) {
      throw new DomainError('bad_balls', '请填写归还球数');
    }
    const isRain = !!input.rain;

    const tx = () => {
      const battery = this.get(`SELECT * FROM batteries WHERE id=?`, b.battery_id);
      const basket = this.get(`SELECT * FROM baskets WHERE id=?`, b.basket_id);
      if (!battery || !basket) throw new DomainError('bad_state', '领用记录不完整');

      const machine = this.get(`SELECT * FROM machines WHERE id=?`, b.machine_id);
      const machineFree = machine.status !== 'maintenance';

      // 电池进入充电（充电完成由调度器置回 ready）
      const until = this.t + CHARGE_MS;
      this.db.prepare(
        `UPDATE batteries SET status='charging', charge_pct=?, charge_started_at=?, charging_until=? WHERE id=?`
        // 归还时按电量读数，演示中保留剩余电量
      ).run(
        Math.max(5, Number.isInteger(input.batteryPct) ? input.batteryPct : 30),
        this.t, until, battery.id
      );
      // 球筐回收
      this.db.prepare(`UPDATE baskets SET status='available' WHERE id=?`).run(basket.id);

      const shortage = b.balls_issued - ballsReturned;
      const newStatus = isRain ? 'rain_stopped' : 'returned';
      let fee = b.fee;
      if (isRain && b.pickup_at) {
        const playedMs = Math.max(0, this.t - b.pickup_at);
        if (b.training_mode_id) {
          const mode = this.get(`SELECT * FROM training_modes WHERE id=?`, b.training_mode_id);
          fee = Math.round(mode.fee_per_hour * (playedMs / 3600e3));
        }
      }
      this.db.prepare(
        `UPDATE bookings SET status=?, balls_returned=?, returned_at=?, charging_ack=1, fee=?
         ${isRain ? ', rain_stopped_at=?' : ''} WHERE id=?`
      ).run(
        newStatus, ballsReturned, this.t, fee, ...(isRain ? [this.t] : []), id
      );

      // 自动登记异常（经理仍需复核扣款）
      if (shortage > BALL_TOLERANCE) {
        this.proposeDeductionInTx(id, 'balls_short', (shortage - BALL_TOLERANCE) * BALL_PRICE,
          { shortage, tolerance: BALL_TOLERANCE, unitPrice: BALL_PRICE },
          `短缺 ${shortage} 颗球（含 ${BALL_TOLERANCE} 颗合理损耗），超出 ${shortage - BALL_TOLERANCE} 颗按 ¥${BALL_PRICE}/颗赔偿`);
      }
      if (input.scratch) {
        this.db.prepare(
          `INSERT INTO incidents (id, booking_id, kind, detail, at) VALUES (?,?,?,?,?)`
        ).run(uid('inc'), id, 'scratch', JSON.stringify({ note: input.scratchNote || '设备刮伤' }), this.t);
        this.proposeDeductionInTx(id, 'scratch', SCRATCH_FEE,
          { scratch: true }, input.scratchNote || '设备刮伤检修费');
      }
      if (isRain) {
        this.db.prepare(
          `INSERT INTO incidents (id, booking_id, kind, detail, at) VALUES (?,?,?,?,?)`
        ).run(uid('inc'), id, 'rain', JSON.stringify({ label: '雨天停场' }), this.t);
        this.db.prepare(`UPDATE courts SET rain_suspended=1 WHERE id=?`).run(b.court_id);
      }
      return { shortage, machineFree, newStatus, fee, chargingUntil: until };
    };
    const out = withTransaction(this.db, tx);
    this.logEvent(id, 'return', { ...input, ...out });
    this.audit('staff', 'booking.return', { id, ballsReturned, rain: isRain });
    return this.bookingDetail(id);
  }

  // ---- 结单：清点完成 + 电池已充电确认 + 押金复核完毕 ----
  settle(id) {
    const b = this.getBooking(id);
    if (!['returned', 'rain_stopped'].includes(b.status)) {
      throw new DomainError('bad_status', `状态 ${b.status} 不能结单`);
    }
    if (!b.charging_ack) throw new DomainError('battery_not_charging', '电池尚未接入充电，不能结单');
    if (b.balls_returned == null) throw new DomainError('not_counted', '尚未完成球数清点');

    const pending = this.list(`SELECT * FROM deductions WHERE booking_id=? AND status='proposed'`, id);
    if (pending.length) throw new DomainError('deduction_pending', '有押金扣款待经理复核', { pending: pending.map((d) => ({ id: d.id, amount: d.amount, reason: d.reason_code })) });

    const idemKey = `settle:${id}`;
    const pay = this.payment.pay({ memberId: b.member_id, amount: b.fee, idemKey, kind: 'fee' });
    if (!pay.ok) throw new DomainError('payment_failed', '费用支付失败：' + pay.reason);

    this.db.prepare(`UPDATE bookings SET status='settled', settled_at=? WHERE id=?`).run(this.t, id);
    this.logEvent(id, 'settled', { fee: b.fee, ref: pay.ref });
    this.audit('system', 'booking.settle', { id, fee: b.fee, ref: pay.ref });
    return this.bookingDetail(id);
  }

  // ---- 押金扣款：经理依据归还记录确认，幂等 ----
  proposeDeductionInTx(bookingId, reasonCode, amount, detailObj, detailText) {
    const idemKey = `${bookingId}:${reasonCode}`;
    const exist = this.get(`SELECT * FROM deductions WHERE idem_key=?`, idemKey);
    if (exist) return exist.id;
    const id = uid('ded');
    this.db.prepare(
      `INSERT INTO deductions (id, booking_id, reason_code, amount, detail, status, proposed_at, idem_key)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run(id, bookingId, reasonCode, amount, detailText || JSON.stringify(detailObj || {}), 'proposed', this.t, idemKey);
    this.logEvent(bookingId, 'deduction.proposed', { id, reasonCode, amount });
    return id;
  }

  proposeDeduction(bookingId, reasonCode, amount, detailText) {
    if (!['balls_short', 'scratch', 'equipment_damage'].includes(reasonCode)) {
      throw new DomainError('bad_reason', '扣款原因不合法');
    }
    if (!(amount > 0)) throw new DomainError('bad_amount', '扣款金额须大于 0');
    const b = this.getBooking(bookingId);
    if (b.balls_returned == null && !['issued', 'returned', 'rain_stopped', 'settled'].includes(b.status)) {
      throw new DomainError('bad_status', '尚无归还记录，不能发起扣款');
    }
    let id;
    const tx = () => {
      id = this.proposeDeductionInTx(bookingId, reasonCode, amount, {}, detailText);
    };
    withTransaction(this.db, tx);
    return this.bookingDetail(bookingId);
  }

  // 经理确认扣款：幂等。重复确认直接返回既有结果，不重复扣款
  confirmDeduction(deductionId, manager) {
    if (!manager) throw new DomainError('forbidden', '扣款确认仅限经理');
    const d = this.get(`SELECT * FROM deductions WHERE id=?`, deductionId);
    if (!d) throw new DomainError('not_found', '扣款单不存在');
    const b = this.getBooking(d.booking_id);
    if (b.balls_returned == null) throw new DomainError('no_return_record', '缺少归还清点记录，不能确认扣款');

    if (d.status === 'confirmed') {
      return { deduction: d, booking: this.bookingDetail(b.id), idempotent: true };
    }
    if (d.status === 'rejected') throw new DomainError('already_rejected', '该扣款已被驳回');

    const member = this.get(`SELECT * FROM members WHERE id=?`, b.member_id);
    if (member.deposit_balance < d.amount) throw new DomainError('deposit_low', '押金余额不足');

    const idemKey = `deduct:${d.idem_key}`;
    const pay = this.payment.pay({ memberId: member.id, amount: d.amount, idemKey, kind: 'deposit_deduction' });
    if (!pay.ok) throw new DomainError('payment_failed', '扣款支付失败：' + pay.reason);

    this.db.prepare(
      `UPDATE deductions SET status='confirmed', confirmed_at=?, manager=?, payment_ref=? WHERE id=?`,
    ).run(this.t, manager, pay.ref, d.id);
    this.db.prepare(`UPDATE members SET deposit_balance = deposit_balance - ? WHERE id=?`).run(d.amount, member.id);
    this.logEvent(b.id, 'deduction.confirmed', { id: d.id, amount: d.amount, manager, ref: pay.ref });
    this.audit(manager, 'deduction.confirm', { id: d.id, amount: d.amount });
    return { deduction: this.get(`SELECT * FROM deductions WHERE id=?`, d.id), booking: this.bookingDetail(b.id) };
  }

  rejectDeduction(deductionId, manager) {
    if (!manager) throw new DomainError('forbidden', '扣款操作仅限经理');
    const d = this.get(`SELECT * FROM deductions WHERE id=?`, deductionId);
    if (!d) throw new DomainError('not_found', '扣款单不存在');
    if (d.status !== 'proposed') throw new DomainError('bad_status', `状态 ${d.status} 不可驳回`);
    this.db.prepare(`UPDATE deductions SET status='rejected', confirmed_at=?, manager=? WHERE id=?`).run(this.t, manager, d.id);
    this.logEvent(d.booking_id, 'deduction.rejected', { id: d.id, manager });
    this.audit(manager, 'deduction.reject', { id: d.id });
    return this.bookingDetail(d.booking_id);
  }

  // ---- 故障与维修 ----
  reportRepair(machineId, { reason, reporter = 'staff', bookingId = null, fee = 0 }) {
    const machine = this.get(`SELECT * FROM machines WHERE id=?`, machineId);
    if (!machine) throw new DomainError('not_found', '发球机不存在');
    const id = uid('rep');
    const tx = () => {
      this.db.prepare(`UPDATE machines SET status='maintenance', note=? WHERE id=?`).run(reason, machineId);
      this.db.prepare(
        `INSERT INTO repairs (id, machine_id, reason, status, reporter, repair_fee, reported_at)
         VALUES (?,?,?,?,?,?,?)`
      ).run(id, machineId, reason, 'open', reporter, fee, this.t);
      if (bookingId) {
        this.db.prepare(
          `INSERT INTO incidents (id, booking_id, kind, detail, at) VALUES (?,?,?,?,?)`
        ).run(uid('inc'), bookingId, 'jam', JSON.stringify({ machine: machine.code, repair: id }), this.t);
      }
    };
    withTransaction(this.db, tx);
    this.audit(reporter, 'machine.repair_open', { machineId, reason, id });
    return this.get(`SELECT * FROM repairs WHERE id=?`, id);
  }

  resolveRepair(repairId, manager = 'manager') {
    const r = this.get(`SELECT * FROM repairs WHERE id=?`, repairId);
    if (!r) throw new DomainError('not_found', '维修单不存在');
    if (r.status === 'repaired') return r;
    this.db.prepare(`UPDATE repairs SET status='repaired', resolved_at=? WHERE id=?`).run(this.t, repairId);
    // 仅当没有其它未结维修单时恢复机器
    const open = this.get(`SELECT COUNT(*) c FROM repairs WHERE machine_id=? AND status='open'`, r.machine_id);
    if (open.c === 0) this.db.prepare(`UPDATE machines SET status='ok', note=NULL WHERE id=?`).run(r.machine_id);
    this.audit(manager, 'machine.repair_done', { repairId });
    return this.get(`SELECT * FROM repairs WHERE id=?`, repairId);
  }

  // ---- 卡球：现场可清除；无法清除则转维修 ----
  reportJam(bookingId, resolved, note) {
    const b = this.getBooking(bookingId);
    if (!['issued'].includes(b.status)) throw new DomainError('bad_status', '仅进行中的训练可登记卡球');
    this.db.prepare(
      `INSERT INTO incidents (id, booking_id, kind, detail, at, resolved_at) VALUES (?,?,?,?,?,?)`
    ).run(uid('inc'), bookingId, 'jam', JSON.stringify({ resolved, note }), this.t, resolved ? this.t : null);
    this.logEvent(bookingId, 'jam', { resolved, note });
    if (!resolved) {
      this.reportRepair(b.machine_id, { reason: '卡球，需拆机检查：' + (note || ''), bookingId });
    }
    return this.bookingDetail(bookingId);
  }

  // ---- 电池掉电更换：旧电池转充电，仅 ready 电池可换入 ----
  swapBattery(bookingId, preferredBatteryId = null) {
    const b = this.getBooking(bookingId);
    if (b.status !== 'issued') throw new DomainError('bad_status', '仅进行中的训练可更换电池');
    const tx = () => {
      const old = this.get(`SELECT * FROM batteries WHERE id=?`, b.battery_id);
      let next;
      if (preferredBatteryId) {
        next = this.get(`SELECT * FROM batteries WHERE id=? AND status='ready'`, preferredBatteryId);
        if (!next) throw new DomainError('battery_not_ready', '目标电池不可用（充电未完成或使用中）');
      } else {
        next = this.get(`SELECT * FROM batteries WHERE status='ready' AND charge_pct >= ? ORDER BY charge_pct DESC LIMIT 1`, MIN_ISSUE_CHARGE);
      }
      if (!next) throw new DomainError('battery_not_ready', '没有可更换的满电电池');
      const until = this.t + CHARGE_MS;
      this.db.prepare(
        `UPDATE batteries SET status='charging', charge_pct=10, charge_started_at=?, charging_until=?, swap_count=swap_count+1 WHERE id=?`
      ).run(this.t, until, old.id);
      this.db.prepare(`UPDATE batteries SET status='in_use' WHERE id=?`).run(next.id);
      this.db.prepare(`UPDATE bookings SET battery_id=? WHERE id=?`).run(next.id, b.id);
      this.db.prepare(
        `INSERT INTO incidents (id, booking_id, kind, detail, at) VALUES (?,?,?,?,?)`
      ).run(uid('inc'), bookingId, 'battery_dead', JSON.stringify({ from: old.code, to: next.code }), this.t);
      return { from: old.code, to: next.code, chargingUntil: until };
    };
    const out = withTransaction(this.db, tx);
    this.logEvent(bookingId, 'battery.swap', out);
    this.audit('staff', 'battery.swap', { bookingId, ...out });
    return this.bookingDetail(bookingId);
  }

  // ---- 球场：雨天停/恢复 ----
  setCourtRain(courtId, suspended, actor = 'staff') {
    const court = this.get(`SELECT * FROM courts WHERE id=?`, courtId);
    if (!court) throw new DomainError('not_found', '球场不存在');
    this.db.prepare(`UPDATE courts SET rain_suspended=? WHERE id=?`).run(suspended ? 1 : 0, courtId);
    this.audit(actor, suspended ? 'court.rain_suspend' : 'court.rain_resume', { courtId });
    if (suspended) {
      const active = this.list(`SELECT * FROM bookings WHERE court_id=? AND status='issued'`, courtId);
      for (const b of active) {
        this.db.prepare(
          `INSERT INTO incidents (id, booking_id, kind, detail, at) VALUES (?,?,?,?,?)`
        ).run(uid('inc'), b.id, 'rain', JSON.stringify({ auto: true }), this.t);
        this.logEvent(b.id, 'rain.alert', {});
      }
    }
    return this.get(`SELECT * FROM courts WHERE id=?`, courtId);
  }

  // ---- 设备可用表 ----
  availability() {
    const latestPhoto = (kind, equipmentId) => {
      const row = this.get(
        `SELECT path,label FROM equipment_photos WHERE kind=? AND equipment_id=? ORDER BY created_at DESC LIMIT 1`,
        kind, equipmentId
      );
      return row || null;
    };
    const courts = this.list(`SELECT * FROM courts ORDER BY id`).map((c) => ({
      ...c,
      rain_suspended: !!c.rain_suspended,
    }));
    const machines = this.list(`SELECT * FROM machines ORDER BY code`).map((m) => ({ ...m, photo: latestPhoto('machine', m.id) }));
    const batteries = this.list(`SELECT * FROM batteries ORDER BY code`).map((x) => ({
      ...x,
      assignable: x.status === 'ready' && x.charge_pct >= MIN_ISSUE_CHARGE,
      photo: latestPhoto('battery', x.id),
    }));
    const baskets = this.list(`SELECT * FROM baskets ORDER BY code`).map((k) => ({ ...k, photo: latestPhoto('basket', k.id) }));
    const openRepairs = this.list(`SELECT * FROM repairs WHERE status='open' ORDER BY reported_at DESC`);
    return { courts, machines, batteries, baskets, openRepairs, thresholds: { minIssueCharge: MIN_ISSUE_CHARGE, chargeMs: CHARGE_MS } };
  }

  members() { return this.list(`SELECT * FROM members ORDER BY id`); }
  modes() { return this.list(`SELECT * FROM training_modes ORDER BY balls_per_hour`); }
  deductions() {
    return this.list(`SELECT d.*, b.code booking_code FROM deductions d JOIN bookings b ON b.id=d.booking_id ORDER BY d.proposed_at DESC`);
  }
  repairs() {
    return this.list(
      `SELECT r.*, m.code machine_code FROM repairs r JOIN machines m ON m.id=r.machine_id ORDER BY r.reported_at DESC`
    );
  }
  incidents() {
    return this.list(
      `SELECT i.*, b.code booking_code FROM incidents i LEFT JOIN bookings b ON b.id=i.booking_id ORDER BY i.at DESC`
    ).map((i) => ({ ...i, detail: safeJson(i.detail) }));
  }
  photos(kind, equipmentId) {
    return this.list(`SELECT * FROM equipment_photos WHERE kind=? AND equipment_id=? ORDER BY created_at DESC`, kind, equipmentId);
  }
  addPhoto(kind, equipmentId, filename, label) {
    const id = uid('ph');
    this.db.prepare(
      `INSERT INTO equipment_photos (id, kind, equipment_id, path, label, created_at) VALUES (?,?,?,?,?,?)`
    ).run(id, kind, equipmentId, filename, label || null, this.t);
    return this.get(`SELECT * FROM equipment_photos WHERE id=?`, id);
  }

  // ---- 调度器单次扫描：迟到释放 + 充电完成 + 雨天感知 ----
  tick() {
    const now = this.t;
    const result = { lateReleased: [], chargesCompleted: [], rainCourts: [] };

    // 1) 迟到释放：confirmed 且已过开场+宽限仍未领用
    const waiting = this.list(
      `SELECT * FROM bookings WHERE status='confirmed' AND start_ms + ? < ?`, LATE_GRACE_MS, now
    );
    for (const b of waiting) {
      withTransaction(this.db, () => {
        this.db.prepare(`UPDATE bookings SET status='released', late_released_at=? WHERE id=? AND status='confirmed'`).run(now, b.id);
        this.logEvent(b.id, 'late_released', { graceMin: LATE_GRACE_MS / 60e3 });
      });
      result.lateReleased.push(b.code);
      this.audit('scheduler', 'booking.late_release', { id: b.id });
    }

    // 2) 充电完成
    const done = this.list(
      `SELECT * FROM batteries WHERE status='charging' AND charging_until <= ?`, now
    );
    for (const bat of done) {
      this.db.prepare(
        `UPDATE batteries SET status='ready', charge_pct=100, charging_until=NULL, charge_started_at=NULL WHERE id=?`
      ).run(bat.id);
      result.chargesCompleted.push(bat.code);
      this.audit('scheduler', 'battery.ready', { id: bat.id });
    }

    // 3) 天气：脚本进入雨天 → 暂停仍开放的球场（仅打标记，不替工作人员归还）；
    //    雨停 → 自动恢复可预约（进行中订单的归还仍由工作人员办理）
    const raining = this.weather.isRaining(now);
    if (raining) {
      const open = this.list(`SELECT * FROM courts WHERE rain_suspended=0 AND status='active'`);
      for (const c of open) {
        this.setCourtRain(c.id, true, 'scheduler');
        result.rainCourts.push(c.name);
      }
    } else {
      const suspended = this.list(`SELECT * FROM courts WHERE rain_suspended=1 AND status='active'`);
      for (const c of suspended) {
        this.setCourtRain(c.id, false, 'scheduler');
        result.rainResumed = result.rainResumed || [];
        result.rainResumed.push(c.name);
      }
    }
    return result;
  }
}

function withTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return s; }
}

module.exports = {
  ClubService,
  DomainError,
  WeatherAdapter,
  PaymentAdapter,
  constants: {
    LATE_GRACE_MS, CHARGE_MS, MIN_ISSUE_CHARGE, BALL_TOLERANCE,
    BALL_PRICE, DEPOSIT_HOLD, SCRATCH_FEE, SLOT_STEP_MIN,
  },
  iso,
};
