"""Domain services: reservations, checkouts, returns, batteries, faults, deposits.

All money is stored in fen (分). Time intervals are half-open [start, end),
so back-to-back bookings (end == next start) do not conflict.
"""
from __future__ import annotations

import sqlite3
import threading
from datetime import datetime, timedelta
from typing import Any, Optional

from .clock import Clock, iso, parse
from .errors import DomainError, Forbidden, NotFound, ResourceConflict

TRAINING_MODES = ["固定点位", "全场随机", "发球专项", "高压截击", "自定义套路"]

BALL_PRICE_FEN = 800          # 每颗网球 ¥8
CHARGE_MINUTES = 45           # 电池归还后标准充电时长
GRACE_MINUTES = 10            # 开场宽限
EARLY_CHECKIN_MIN = 20        # 最多提前 20 分钟领用

# 占用球场/机器时段的预约状态
LOCKING_STATUSES = ("booked", "checked_out", "active", "extended", "rain_suspended")
OPEN_STATUSES = ("booked", "checked_out", "active", "extended", "rain_suspended")


class ClubService:
    def __init__(self, conn: sqlite3.Connection, clock: Clock,
                 weather=None, payment=None):
        self.conn = conn
        self.clock = clock
        self.weather = weather
        self.payment = payment
        self._lock = threading.RLock()

    # ------------------------------------------------------------------ utils
    def _one(self, sql: str, args: tuple = ()) -> Optional[sqlite3.Row]:
        return self.conn.execute(sql, args).fetchone()

    def _all(self, sql: str, args: tuple = ()) -> list[sqlite3.Row]:
        return self.conn.execute(sql, args).fetchall()

    @staticmethod
    def _dict(row: Optional[sqlite3.Row]) -> Optional[dict]:
        return dict(row) if row is not None else None

    def _get(self, table: str, rid: int) -> sqlite3.Row:
        row = self._one(f"SELECT * FROM {table} WHERE id=?", (rid,))
        if row is None:
            raise NotFound(f"{table}#{rid} 不存在")
        return row

    # ---------------------------------------------------------- availability
    def _overlap(self, court_id: int, machine_id: int,
                 start: datetime, end: datetime,
                 exclude_id: Optional[int] = None) -> Optional[sqlite3.Row]:
        """Return a reservation overlapping on court OR machine in the window."""
        placeholders = ",".join("?" for _ in LOCKING_STATUSES)
        rows = self._all(
            f"""SELECT id, code, court_id, machine_id, start_ts, end_ts, status
                FROM reservations
                WHERE status IN ({placeholders})
                  AND (court_id = ? OR machine_id = ?)
                  AND start_ts < ? AND end_ts > ?
                  AND id IS NOT COALESCE(?, -1)""",
            (*LOCKING_STATUSES, court_id, machine_id, iso(end), iso(start),
             exclude_id),
        )
        for r in rows:
            if r["court_id"] == court_id:
                return r  # 调用方按字段判断 resource
        return rows[0] if rows else None

    def _overlap_detail(self, court_id, machine_id, start, end, exclude_id=None):
        placeholders = ",".join("?" for _ in LOCKING_STATUSES)
        rows = self._all(
            f"""SELECT * FROM reservations
                WHERE status IN ({placeholders})
                  AND (court_id = ? OR machine_id = ?)
                  AND start_ts < ? AND end_ts > ?
                  AND id IS NOT COALESCE(?, -1)""",
            (*LOCKING_STATUSES, court_id, machine_id, iso(end), iso(start),
             exclude_id),
        )
        court_hit = next((r for r in rows if r["court_id"] == court_id), None)
        machine_hit = next((r for r in rows if r["machine_id"] == machine_id), None)
        return court_hit, machine_hit

    def equipment_table(self) -> dict[str, Any]:
        now = self.clock.now()
        machines = [dict(r) for r in self._all("SELECT * FROM machines ORDER BY code")]
        batteries = [dict(r) for r in self._all("SELECT * FROM batteries ORDER BY code")]
        baskets = [dict(r) for r in self._all("SELECT * FROM baskets ORDER BY code")]
        courts = [dict(r) for r in self._all("SELECT * FROM courts ORDER BY code")]
        for b in batteries:
            if b["status"] == "charging" and b["charge_ready_ts"]:
                ready = parse(b["charge_ready_ts"])
                b["charge_remaining_min"] = max(0, int((ready - now).total_seconds() // 60) + 1)
        open_faults = {f["machine_id"]: dict(f)
                       for f in self._all("SELECT * FROM faults WHERE status='open'")}
        for m in machines:
            m["open_fault"] = open_faults.get(m["id"])
        return {"courts": courts, "machines": machines,
                "batteries": batteries, "baskets": baskets, "now": iso(now)}

    def calendar(self, day: Optional[str] = None) -> dict[str, Any]:
        """All reservations for a day (default today), with member/resource names."""
        today = self.clock.now().date().isoformat()
        day = day or today
        rows = self._all(
            """SELECT r.*, m.name AS member_name, c.code AS court_code,
                      ma.code AS machine_code, ma.model AS machine_model,
                      co.balls_issued, co.battery_id, co.basket_id,
                      ba.code AS basket_code, bt.code AS battery_code,
                      rt.balls_returned, rt.balls_short, rt.scratch, rt.jammed,
                      dr.total_deducted, dr.refunded, dr.status AS review_status
               FROM reservations r
               JOIN members m  ON m.id = r.member_id
               JOIN courts c   ON c.id = r.court_id
               JOIN machines ma ON ma.id = r.machine_id
               LEFT JOIN checkouts co ON co.reservation_id = r.id
               LEFT JOIN baskets ba   ON ba.id = co.basket_id
               LEFT JOIN batteries bt ON bt.id = co.battery_id
               LEFT JOIN returns rt   ON rt.reservation_id = r.id
               LEFT JOIN deposit_reviews dr ON dr.reservation_id = r.id
               WHERE substr(r.start_ts,1,10) = ?
               ORDER BY r.start_ts, r.id""",
            (day,),
        )
        return {"day": day, "reservations": [dict(r) for r in rows],
                "now": iso(self.clock.now())}

    # ------------------------------------------------------------ reservation
    def create_reservation(self, *, member_id: int, court_id: int, machine_id: int,
                           start: datetime, end: datetime,
                           training_mode: str, deposit: int,
                           grace_minutes: int = GRACE_MINUTES,
                           allow_past: bool = False) -> dict:
        with self._lock:
            if end <= start:
                raise DomainError("结束时间必须晚于开始时间")
            if not allow_past and start < self.clock.now() - timedelta(minutes=1):
                raise DomainError("不能预约过去的时段")
            self._get("members", member_id)
            court = self._get("courts", court_id)
            machine = self._get("machines", machine_id)
            if court["status"] != "open":
                raise ResourceConflict("该球场因雨停场，暂不可预约", "court", court_id)
            if machine["status"] == "maintenance":
                raise ResourceConflict(
                    f"发球机 {machine['code']} 维修中，不可分配", "machine", machine_id)
            # 注意：机器“使用中”不拦未来预约——时间重叠校验会挡住真正的冲突
            if training_mode not in TRAINING_MODES:
                raise DomainError(f"未知训练模式: {training_mode}")
            if deposit < 0:
                raise DomainError("押金不能为负")

            court_hit, machine_hit = self._overlap_detail(
                court_id, machine_id, start, end)
            if court_hit:
                raise ResourceConflict(
                    f"球场 {court['code']} 在 {court_hit['start_ts'][11:16]}"
                    f"–{court_hit['end_ts'][11:16]} 已被 {court_hit['code']} 占用",
                    "court", court_hit["id"])
            if machine_hit:
                raise ResourceConflict(
                    f"发球机 {machine['code']} 在 {machine_hit['start_ts'][11:16]}"
                    f"–{machine_hit['end_ts'][11:16]} 已被 {machine_hit['code']} 占用",
                    "machine", machine_hit["id"])

            now = self.clock.now()
            seq = self._one("SELECT COUNT(*) AS n FROM reservations")["n"] + 1
            code = f"R-{now.strftime('%m%d')}-{seq:03d}-{member_id:02d}{court_id}{machine_id}"
            cur = self.conn.execute(
                """INSERT INTO reservations
                   (code, member_id, court_id, machine_id, start_ts, end_ts,
                    training_mode, deposit, status, grace_minutes, created_ts)
                   VALUES (?,?,?,?,?,?,?,?, 'booked', ?,?)""",
                (code, member_id, court_id, machine_id, iso(start), iso(end),
                 training_mode, deposit, grace_minutes, iso(now)))
            self.conn.commit()
            return dict(self._get("reservations", cur.lastrowid))

    def extend_reservation(self, rid: int, minutes: int) -> dict:
        """临时续场：重新检查球场与发球机的后续预约。"""
        with self._lock:
            r = self._get("reservations", rid)
            if r["status"] not in ("active", "checked_out", "extended"):
                raise DomainError(f"当前状态 {r['status']} 不允许续场")
            if minutes <= 0 or minutes > 180:
                raise DomainError("续场分钟数需在 1–180 之间")
            start, end = parse(r["start_ts"]), parse(r["end_ts"])
            new_end = end + timedelta(minutes=minutes)
            if new_end <= self.clock.now():
                raise DomainError("原时段已结束太久，无法续场")
            court_hit, machine_hit = self._overlap_detail(
                r["court_id"], r["machine_id"], start, new_end, exclude_id=rid)
            if court_hit:
                raise ResourceConflict(
                    f"续场失败：球场后续预约 {court_hit['code']} "
                    f"{court_hit['start_ts'][11:16]} 开始", "court", court_hit["id"])
            if machine_hit:
                raise ResourceConflict(
                    f"续场失败：发球机后续预约 {machine_hit['code']} "
                    f"{machine_hit['start_ts'][11:16]} 开始", "machine", machine_hit["id"])
            self.conn.execute(
                "UPDATE reservations SET end_ts=?, status='extended', "
                "note = note || ? WHERE id=?",
                (iso(new_end), f" [{iso(self.clock.now())[:16]} 临时续场+{minutes}分]", rid))
            self.conn.commit()
            return dict(self._get("reservations", rid))

    def cancel_reservation(self, rid: int) -> dict:
        with self._lock:
            r = self._get("reservations", rid)
            if r["status"] not in ("booked",):
                raise DomainError("已领用的预约不能直接取消，请走归还流程")
            self.conn.execute("UPDATE reservations SET status='late_released', "
                              "note=note||' [已取消]' WHERE id=?", (rid,))
            self.conn.commit()
            return dict(self._get("reservations", rid))

    # -------------------------------------------------------------- checkout
    def checkout(self, rid: int, battery_id: int, basket_id: int,
                 balls_issued: int, checker: str) -> dict:
        """开场前领用：同时把电池、球筐、机器置为占用。"""
        with self._lock:
            r = self._get("reservations", rid)
            now = self.clock.now()
            if r["status"] != "booked":
                raise DomainError(f"预约状态 {r['status']}，不能领用")
            start, end = parse(r["start_ts"]), parse(r["end_ts"])
            if now < start - timedelta(minutes=EARLY_CHECKIN_MIN):
                raise DomainError(f"最多提前 {EARLY_CHECKIN_MIN} 分钟领用")
            if now > end:
                raise DomainError("预约时段已结束，不能领用")
            machine = self._get("machines", r["machine_id"])
            if machine["status"] != "available":
                raise ResourceConflict(
                    f"发球机 {machine['code']} {machine['status']}，不可领用",
                    "machine", machine_id)
            battery = self._get("batteries", battery_id)
            if battery["status"] != "charged":
                raise ResourceConflict(
                    f"电池 {battery['code']} 状态为 {battery['status']}，"
                    "充电未完成不可分配", "battery", battery_id)
            basket = self._get("baskets", basket_id)
            if basket["status"] != "available":
                raise ResourceConflict(
                    f"球筐 {basket['code']} 已被领用", "basket", basket_id)
            if balls_issued <= 0 or balls_issued > basket["capacity"]:
                raise DomainError(
                    f"领用球数需在 1–{basket['capacity']}（球筐容量）之间")

            self.conn.execute(
                """INSERT INTO checkouts
                   (reservation_id, battery_id, basket_id, balls_issued,
                    checkout_ts, checker) VALUES (?,?,?,?,?,?)""",
                (rid, battery_id, basket_id, balls_issued, iso(now), checker))
            self.conn.execute("UPDATE machines SET status='in_use' WHERE id=?",
                              (machine["id"],))
            self.conn.execute("UPDATE batteries SET status='in_use' WHERE id=?",
                              (battery_id,))
            self.conn.execute("UPDATE baskets SET status='in_use' WHERE id=?",
                              (basket_id,))
            self.conn.execute(
                "UPDATE reservations SET status='checked_out', checked_out_ts=? "
                "WHERE id=?", (iso(now), rid))
            self.conn.commit()
            return self.session_detail(rid)

    def start_training(self, rid: int) -> dict:
        with self._lock:
            r = self._get("reservations", rid)
            if r["status"] != "checked_out":
                raise DomainError("只有已领用未开场的预约可以开始训练")
            self.conn.execute("UPDATE reservations SET status='active' WHERE id=?",
                              (rid,))
            self.conn.commit()
            return self.session_detail(rid)

    def current_battery_id(self, rid: int) -> int:
        swap = self._one(
            "SELECT new_battery_id FROM battery_swaps WHERE reservation_id=? "
            "ORDER BY id DESC LIMIT 1", (rid,))
        if swap:
            return swap["new_battery_id"]
        co = self._one("SELECT battery_id FROM checkouts WHERE reservation_id=?",
                       (rid,))
        if co is None:
            raise DomainError("该预约尚未领用电池")
        return co["battery_id"]

    def swap_battery(self, rid: int, new_battery_id: int, reason: str = "掉电") -> dict:
        """训练中电池掉电：旧电池送去充电，换满电电池。"""
        with self._lock:
            r = self._get("reservations", rid)
            if r["status"] not in ("active", "checked_out", "extended"):
                raise DomainError("仅训练中的预约可以更换电池")
            old_id = self.current_battery_id(rid)
            if old_id == new_battery_id:
                raise DomainError("新电池不能与当前电池相同")
            old = self._get("batteries", old_id)
            if old["status"] != "in_use":
                raise DomainError(f"原电池 {old['code']} 不在使用中")
            new = self._get("batteries", new_battery_id)
            if new["status"] != "charged":
                raise ResourceConflict(
                    f"电池 {new['code']} {new['status']}，充电未完成不可分配",
                    "battery", new_battery_id)
            now = self.clock.now()
            self.conn.execute(
                "UPDATE batteries SET status='charging', charge_ready_ts=? WHERE id=?",
                (iso(now + timedelta(minutes=CHARGE_MINUTES)), old_id))
            self.conn.execute("UPDATE batteries SET status='in_use' WHERE id=?",
                              (new_battery_id,))
            self.conn.execute(
                """INSERT INTO battery_swaps
                   (reservation_id, old_battery_id, new_battery_id, reason, swap_ts)
                   VALUES (?,?,?,?,?)""",
                (rid, old_id, new_battery_id, reason, iso(now)))
            self.conn.execute(
                "INSERT INTO faults (machine_id, reservation_id, kind, description,"
                " reported_ts, status) VALUES (?,?,?, 'poweroff', ?, 'open')",
                (r["machine_id"], rid, f"电池 {old['code']} 训练中{reason}，已更换",
                 iso(now)))
            self.conn.commit()
            return self.session_detail(rid)

    # ---------------------------------------------------------------- return
    def return_equipment(self, rid: int, *, balls_returned: int,
                         scratch_fen: int = 0, jammed: bool = False,
                         battery_replaced: bool = False,
                         inspector: str = "前台", note: str = "") -> dict:
        """训练结束归还：设备 + 球筐 + 散球清点；电池进入充电方可结单。"""
        with self._lock:
            r = self._get("reservations", rid)
            if r["status"] not in ("active", "checked_out", "extended",
                                   "rain_suspended"):
                raise DomainError(f"状态 {r['status']} 不能归还结单")
            co = self._one("SELECT * FROM checkouts WHERE reservation_id=?", (rid,))
            if co is None:
                raise DomainError("尚无领用记录，不能归还")
            if balls_returned < 0:
                raise DomainError("归还球数不能为负")
            if balls_returned > co["balls_issued"] + 30:
                raise DomainError("归还球数超出领用数过多，请核对")
            if scratch_fen < 0:
                raise DomainError("刮伤赔偿不能为负")
            now = self.clock.now()
            short = max(0, co["balls_issued"] - balls_returned)
            was_rain = r["status"] == "rain_suspended"

            self.conn.execute(
                """INSERT INTO returns
                   (reservation_id, balls_returned, balls_short, scratch, jammed,
                    battery_replaced, return_ts, inspector, note)
                   VALUES (?,?,?,?,?,?,?,?,?)""",
                (rid, balls_returned, short, scratch_fen, 1 if jammed else 0,
                 1 if battery_replaced else 0, iso(now), inspector, note))

            # 电池进入充电（未充完不可再分配，由后台任务到点转 charged）
            bat_id = self.current_battery_id(rid)
            self.conn.execute(
                "UPDATE batteries SET status='charging', charge_ready_ts=? WHERE id=?",
                (iso(now + timedelta(minutes=CHARGE_MINUTES)), bat_id))
            # 球筐立即可用
            self.conn.execute("UPDATE baskets SET status='available' WHERE id=?",
                              (co["basket_id"],))
            # 机器：卡球要拆机 → 维修中；刮伤登记故障但不阻断（仍可继续使用）
            machine_status = "maintenance" if jammed else "available"
            self.conn.execute("UPDATE machines SET status=? WHERE id=?",
                              (machine_status, r["machine_id"]))
            if jammed:
                self.conn.execute(
                    "INSERT INTO faults (machine_id, reservation_id, kind,"
                    " description, reported_ts, status) VALUES (?,?,'jam',?,?, 'open')",
                    (r["machine_id"], rid, f"归还时卡球，{inspector} 报维修", iso(now)))
            if scratch_fen:
                self.conn.execute(
                    "INSERT INTO faults (machine_id, reservation_id, kind,"
                    " description, reported_ts, status) VALUES (?,?,'scratch',?,?, 'open')",
                    (r["machine_id"], rid,
                     f"设备刮伤，建议赔偿 {scratch_fen // 100} 元", iso(now)))

            self.conn.execute(
                "UPDATE reservations SET status=?, released_at=? WHERE id=?",
                ("rain_closed" if was_rain else "closed", iso(now), rid))
            self.conn.commit()
            return self.session_detail(rid)

    # ---------------------------------------------------------------- faults
    def report_fault(self, machine_id: int, kind: str, description: str,
                     reservation_id: Optional[int] = None,
                     maintain: bool = True) -> dict:
        with self._lock:
            self._get("machines", machine_id)
            if kind not in ("jam", "poweroff", "scratch", "other"):
                raise DomainError("未知故障类型")
            now = self.clock.now()
            cur = self.conn.execute(
                "INSERT INTO faults (machine_id, reservation_id, kind, description,"
                " reported_ts, status) VALUES (?,?,?,?,?, 'open')",
                (machine_id, reservation_id, kind, description, iso(now)))
            if maintain:
                self.conn.execute(
                    "UPDATE machines SET status='maintenance' WHERE id=?",
                    (machine_id,))
            self.conn.commit()
            return dict(self._get("faults", cur.lastrowid))

    def repair_fault(self, fault_id: int, resolution: str, mechanic: str) -> dict:
        """维修完成：机器恢复可分配；未决故障全部关闭。"""
        with self._lock:
            f = self._get("faults", fault_id)
            now = self.clock.now()
            self.conn.execute(
                "UPDATE faults SET status='repaired', resolved_ts=?, resolution=? "
                "WHERE id=?", (iso(now), f"{mechanic}: {resolution}", fault_id))
            # 该机没有其他未决故障时才可恢复
            remaining = self._one(
                "SELECT COUNT(*) AS n FROM faults WHERE machine_id=? AND status='open'",
                (f["machine_id"],))
            if remaining["n"] == 0:
                self.conn.execute(
                    "UPDATE machines SET status='available' WHERE id=? AND status='maintenance'",
                    (f["machine_id"],))
            self.conn.commit()
            return dict(self._get("faults", fault_id))

    def faults(self, open_only: bool = False) -> list[dict]:
        sql = ("SELECT f.*, ma.code AS machine_code, r.code AS reservation_code "
               "FROM faults f JOIN machines ma ON ma.id=f.machine_id "
               "LEFT JOIN reservations r ON r.id=f.reservation_id ")
        if open_only:
            sql += "WHERE f.status='open' "
        sql += "ORDER BY f.id DESC"
        return [dict(r) for r in self._all(sql)]

    # ----------------------------------------------------------------- rain
    def rain_suspend_all(self, reason: str = "暴雨预警",
                         window_min: int = 60) -> dict:
        """雨天停场：挂起当前进行中及 window_min 分钟内开始的预约。

        更远的未来预约保持 booked；已结单/已释放的不受影响。
        """
        with self._lock:
            now = self.clock.now()
            horizon = iso(now + timedelta(minutes=window_min))
            if self._one("SELECT 1 FROM rain_log WHERE ended_ts IS NULL"):
                raise DomainError("当前已有进行中的雨停记录")
            self.conn.execute(
                "INSERT INTO rain_log (started_ts, reason) VALUES (?,?)",
                (iso(now), reason))
            placeholders = ",".join("?" for _ in LOCKING_STATUSES)
            rows = self._all(
                f"""SELECT * FROM reservations
                    WHERE status IN ({placeholders})
                      AND end_ts > ? AND start_ts <= ?""",
                (*LOCKING_STATUSES, iso(now), horizon))
            for r in rows:
                self.conn.execute(
                    "UPDATE reservations SET status='rain_suspended', prev_status=? "
                    "WHERE id=?", (r["status"], r["id"]))
                # 设备仍在客人手中（已领用），机器只解锁日程占用，不改变设备物理状态
            self.conn.execute("UPDATE courts SET status='suspended'")
            self.conn.commit()
            return {"suspended": len(rows), "started_ts": iso(now), "reason": reason}

    def rain_resume(self) -> dict:
        with self._lock:
            log = self._one("SELECT * FROM rain_log WHERE ended_ts IS NULL")
            if not log:
                raise DomainError("当前没有进行中的雨停记录")
            now = self.clock.now()
            rows = self._all(
                "SELECT * FROM reservations WHERE status='rain_suspended'")
            restored, released = 0, 0
            for r in rows:
                prev = r["prev_status"] or "booked"
                end = parse(r["end_ts"])
                if end <= now:
                    # 雨停时时段已过 → 释放，未领用的退回设备
                    self.conn.execute(
                        "UPDATE reservations SET status='late_released', "
                        "note=note||? WHERE id=?",
                        (f" [雨停至 {iso(now)[:16]}，时段结束自动释放]", r["id"]))
                    co = self._one(
                        "SELECT * FROM checkouts WHERE reservation_id=? "
                        "AND reservation_id NOT IN (SELECT reservation_id FROM returns)",
                        (r["id"],))
                    if co:
                        self._free_checkout_gear(co, now)
                    released += 1
                else:
                    self.conn.execute(
                        "UPDATE reservations SET status=? WHERE id=?", (prev, r["id"]))
                    restored += 1
            self.conn.execute("UPDATE courts SET status='open'")
            self.conn.execute("UPDATE rain_log SET ended_ts=? WHERE id=?",
                              (iso(now), log["id"]))
            self.conn.commit()
            return {"restored": restored, "released": released, "ended_ts": iso(now)}

    def _free_checkout_gear(self, co: sqlite3.Row, now: datetime) -> None:
        """Release gear of a killed session without a return record."""
        self.conn.execute("UPDATE baskets SET status='available' WHERE id=?",
                          (co["basket_id"],))
        self.conn.execute(
            "UPDATE batteries SET status='charging', charge_ready_ts=? WHERE id=?",
            (iso(now + timedelta(minutes=CHARGE_MINUTES)), co["battery_id"]))
        # 机器是否仍被其他人占用？本系统一机一订单，直接可用
        self.conn.execute(
            "UPDATE machines SET status='available' WHERE id="
            "(SELECT machine_id FROM reservations WHERE id=?)",
            (co["reservation_id"],))

    def rain_status(self) -> dict:
        log = self._dict(self._one(
            "SELECT * FROM rain_log WHERE ended_ts IS NULL ORDER BY id DESC LIMIT 1"))
        return {"active": log is not None, "log": log,
                "forecast": self.weather.forecast() if self.weather else None}

    # ------------------------------------------------------------ background
    def release_late(self) -> list[int]:
        """迟到释放：超过宽限未领用的预约自动释放。"""
        released: list[int] = []
        with self._lock:
            now = self.clock.now()
            rows = self._all(
                "SELECT * FROM reservations WHERE status = 'booked'")
            for r in rows:
                deadline = parse(r["start_ts"]) + timedelta(minutes=r["grace_minutes"])
                if deadline < now:
                    self.conn.execute(
                        "UPDATE reservations SET status='late_released', released_at=?,"
                        " note=note||? WHERE id=?",
                        (iso(now),
                         f" [超过宽限{r['grace_minutes']}分钟未到场，自动释放]",
                         r["id"]))
                    released.append(r["id"])
            self.conn.commit()
        return released

    def complete_charges(self) -> list[int]:
        """充电到点的电池转为满电可分配。"""
        done: list[int] = []
        with self._lock:
            now = self.clock.now()
            rows = self._all(
                "SELECT * FROM batteries WHERE status='charging' "
                "AND charge_ready_ts IS NOT NULL AND charge_ready_ts <= ?",
                (iso(now),))
            for b in rows:
                self.conn.execute(
                    "UPDATE batteries SET status='charged', charge_ready_ts=NULL "
                    "WHERE id=?", (b["id"],))
                done.append(b["id"])
            self.conn.commit()
        return done

    # -------------------------------------------------------- deposit review
    def pending_deposit_reviews(self) -> list[dict]:
        rows = self._all(
            """SELECT r.id, r.code, r.deposit, r.training_mode,
                      m.name AS member_name, c.code AS court_code,
                      ma.code AS machine_code,
                      rt.balls_short, rt.scratch, rt.return_ts, rt.note AS return_note,
                      co.balls_issued, rt.balls_returned
               FROM returns rt
               JOIN reservations r ON r.id = rt.reservation_id
               JOIN members m ON m.id = r.member_id
               JOIN courts c ON c.id = r.court_id
               JOIN machines ma ON ma.id = r.machine_id
               JOIN checkouts co ON co.reservation_id = r.id
               LEFT JOIN deposit_reviews dr ON dr.reservation_id = r.id
               WHERE dr.id IS NULL
               ORDER BY rt.return_ts""")
        return [dict(x) for x in rows]

    def review_deposit(self, rid: int, *, role: str, manager: str,
                       balls_fee: Optional[int] = None,
                       scratch_fee: Optional[int] = None,
                       other_fee: int = 0,
                       confirm: bool = False) -> dict:
        """经理根据归还记录确认押金扣款。幂等：同一订单只能确认一次。

        非经理可以试算预览，但 confirm=True 必须经理。
        """
        with self._lock:
            r = self._get("reservations", rid)
            existing = self._one(
                "SELECT * FROM deposit_reviews WHERE reservation_id=?", (rid,))
            if existing:
                # 幂等：重复确认直接返回原结果，不重复扣款
                result = dict(existing)
                result["idempotent"] = True
                return result
            ret = self._one("SELECT * FROM returns WHERE reservation_id=?", (rid,))
            if ret is None:
                raise DomainError("尚无归还清点记录，不能复核押金")
            bf = (ret["balls_short"] * BALL_PRICE_FEN
                  if balls_fee is None else balls_fee)
            sf = ret["scratch"] if scratch_fee is None else scratch_fee
            if min(bf, sf, other_fee) < 0:
                raise DomainError("扣款金额不能为负")
            total = bf + sf + other_fee
            if not confirm:
                # 预览（任何角色都可试算）
                return {"preview": True, "reservation_id": rid,
                        "deposit": r["deposit"], "balls_short": ret["balls_short"],
                        "balls_fee": bf, "scratch_fee": sf, "other_fee": other_fee,
                        "total_deducted": total,
                        "refunded": max(0, r["deposit"] - total)}
            if role != "manager":
                raise Forbidden("只有经理可以确认押金扣款")
            if total > r["deposit"]:
                raise DomainError(
                    f"扣款合计 {total} 分超过押金 {r['deposit']} 分，"
                    "请调整或登记补缴")
            refund = r["deposit"] - total
            now = self.clock.now()
            txn = None
            if self.payment is not None:
                if refund > 0:
                    txn = self.payment.refund(
                        r["code"], refund, idem_key=f"dep-{rid}")["txn"]
                elif total > 0:
                    txn = self.payment.capture(
                        r["code"], total, idem_key=f"dep-{rid}")["txn"]
            cur = self.conn.execute(
                """INSERT INTO deposit_reviews
                   (reservation_id, balls_fee, scratch_fee, other_fee,
                    total_deducted, refunded, manager, decided_ts, payment_txn,
                    status) VALUES (?,?,?,?,?,?,?,?,?, 'confirmed')""",
                (rid, bf, sf, other_fee, total, refund, manager, iso(now), txn))
            self.conn.commit()
            row = dict(self._get("deposit_reviews", cur.lastrowid))
            row["payment_txn"] = txn
            return row

    def deposit_reviews(self) -> list[dict]:
        return [dict(r) for r in self._all(
            "SELECT dr.*, r.code AS reservation_code, m.name AS member_name "
            "FROM deposit_reviews dr JOIN reservations r ON r.id=dr.reservation_id "
            "JOIN members m ON m.id=r.member_id ORDER BY dr.id DESC")]

    # ------------------------------------------------------------- sessions
    def session_detail(self, rid: int) -> dict:
        r = self._dict(self._one(
            """SELECT r.*, m.name AS member_name, m.level AS member_level,
                      c.code AS court_code, ma.code AS machine_code,
                      co.balls_issued, co.checkout_ts, co.basket_id, co.battery_id,
                      ba.code AS basket_code, bt.code AS battery_code,
                      rt.balls_returned, rt.balls_short, rt.scratch, rt.jammed,
                      rt.return_ts, rt.note AS return_note
               FROM reservations r
               JOIN members m ON m.id=r.member_id
               JOIN courts c ON c.id=r.court_id
               JOIN machines ma ON ma.id=r.machine_id
               LEFT JOIN checkouts co ON co.reservation_id=r.id
               LEFT JOIN baskets ba ON ba.id=co.basket_id
               LEFT JOIN batteries bt ON bt.id=co.battery_id
               LEFT JOIN returns rt ON rt.reservation_id=r.id
               WHERE r.id=?""", (rid,)))
        if r is None:
            raise NotFound(f"预约 #{rid} 不存在")
        now = self.clock.now()
        co_row = self._one("SELECT * FROM checkouts WHERE reservation_id=?", (rid,))
        r["swaps"] = [dict(s) for s in self._all(
            "SELECT bs.*, ob.code AS old_code, nb.code AS new_code "
            "FROM battery_swaps bs JOIN batteries ob ON ob.id=bs.old_battery_id "
            "JOIN batteries nb ON nb.id=bs.new_battery_id "
            "WHERE bs.reservation_id=? ORDER BY bs.id", (rid,))]
        if co_row:
            r["current_battery_id"] = self.current_battery_id(rid)
            cur_bat = self._get("batteries", r["current_battery_id"])
            r["current_battery_code"] = cur_bat["code"]
            elapsed = int((now - parse(co_row["checkout_ts"])).total_seconds())
            r["elapsed_sec"] = max(0, elapsed)
            sched_left = int((parse(r["end_ts"]) - now).total_seconds())
            r["scheduled_remaining_sec"] = sched_left
            r["overrun"] = sched_left < 0
        r["now"] = iso(now)
        r["photos"] = [dict(p) for p in self._all(
            "SELECT * FROM photos WHERE ref_type='machine' AND ref_id=? "
            "UNION ALL SELECT * FROM photos WHERE ref_type='basket' AND ref_id=?",
            (r["machine_id"], co_row["basket_id"] if co_row else -1))]
        r["review"] = self._dict(self._one(
            "SELECT * FROM deposit_reviews WHERE reservation_id=?", (rid,)))
        return r

    def reservations_open(self) -> list[dict]:
        rows = self._all(
            """SELECT r.*, m.name AS member_name, c.code AS court_code,
                      ma.code AS machine_code
               FROM reservations r
               JOIN members m ON m.id=r.member_id
               JOIN courts c ON c.id=r.court_id
               JOIN machines ma ON ma.id=r.machine_id
               WHERE r.status IN (""" + ",".join("?" for _ in OPEN_STATUSES) + """)
               ORDER BY r.start_ts""",
            OPEN_STATUSES)
        return [dict(x) for x in rows]

    # --------------------------------------------------------------- photos
    def add_photo(self, ref_type: str, ref_id: int, filename: str,
                  label: str) -> dict:
        with self._lock:
            if ref_type not in ("machine", "basket", "court"):
                raise DomainError("照片归属类型只能是 machine/basket/court")
            self._get({"machine": "machines", "basket": "baskets",
                       "court": "courts"}[ref_type], ref_id)
            now = self.clock.now()
            cur = self.conn.execute(
                "INSERT OR IGNORE INTO photos (ref_type, ref_id, path, label, taken_ts)"
                " VALUES (?,?,?,?,?)",
                (ref_type, ref_id, filename, label, iso(now)))
            self.conn.commit()
            return {"id": cur.lastrowid, "ref_type": ref_type, "ref_id": ref_id,
                    "path": filename, "label": label}

    def list_photos(self, ref_type: Optional[str] = None,
                    ref_id: Optional[int] = None) -> list[dict]:
        sql, args = "SELECT * FROM photos", []
        conds = []
        if ref_type:
            conds.append("ref_type=?"); args.append(ref_type)
        if ref_id is not None:
            conds.append("ref_id=?"); args.append(ref_id)
        if conds:
            sql += " WHERE " + " AND ".join(conds)
        sql += " ORDER BY id DESC"
        return [dict(r) for r in self._all(sql, tuple(args))]

    def members(self) -> list[dict]:
        return [dict(r) for r in self._all("SELECT * FROM members ORDER BY id")]
