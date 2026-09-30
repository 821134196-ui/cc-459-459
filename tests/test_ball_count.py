"""球数差异：归还清点、短缺计算、卡球、刮伤、电池充电联动。"""
from datetime import timedelta

from app.errors import DomainError
from tests.support import T0, ClubTestCase


class TestBallCount(ClubTestCase):
    def _active(self):
        r = self.book(start=T0 - timedelta(minutes=30),
                      end=T0 + timedelta(minutes=30), allow_past=True)
        self.checkin(r, battery=1, basket=1, balls=60)
        return r

    def test_exact_count_short_zero_and_gear_freed(self):
        r = self._active()
        out = self.close(r, returned=60)
        self.assertEqual(out["balls_short"], 0)
        self.assertEqual(out["status"], "closed")
        basket = self.svc._get("baskets", 1)
        machine = self.svc._get("machines", 1)
        battery = self.svc._get("batteries", 1)
        self.assertEqual(basket["status"], "available")
        self.assertEqual(machine["status"], "available")
        # 电池进入充电且未充满前不可分配
        self.assertEqual(battery["status"], "charging")
        self.assertIsNotNone(battery["charge_ready_ts"])

    def test_shortage_counted_and_battery_still_charges_before_review(self):
        r = self._active()
        out = self.close(r, returned=54)  # 短缺 6
        self.assertEqual(out["balls_short"], 6)
        # 清点完成即可结单；扣款要等经理复核
        self.assertIsNone(self.svc.conn.execute(
            "SELECT * FROM deposit_reviews WHERE reservation_id=?",
            (r["id"],)).fetchone())
        pending = self.svc.pending_deposit_reviews()
        self.assertEqual([p["id"] for p in pending], [r["id"]])
        self.assertEqual(pending[0]["balls_short"], 6)

    def test_jammed_machine_enters_maintenance_blocks_allocation(self):
        r = self._active()
        self.close(r, returned=60, jammed=True)
        machine = self.svc._get("machines", 1)
        self.assertEqual(machine["status"], "maintenance")
        # 新预约不能分配这台机器
        from app.errors import ResourceConflict
        with self.assertRaises(ResourceConflict):
            self.book(court=2, machine=1, member=2,
                      start=T0 + timedelta(hours=3),
                      end=T0 + timedelta(hours=4))
        # 修复后可分配
        fid = self.svc.conn.execute(
            "SELECT id FROM faults WHERE machine_id=1 AND status='open'"
        ).fetchone()["id"]
        self.svc.repair_fault(fid, "清理卡球", "李工")
        ok = self.book(court=2, machine=1, member=2,
                       start=T0 + timedelta(hours=3),
                       end=T0 + timedelta(hours=4))
        self.assertEqual(ok["status"], "booked")

    def test_scratch_recorded_as_fault_but_machine_stays_usable(self):
        r = self._active()
        self.close(r, returned=60, scratch_fen=5000)
        self.assertEqual(self.svc._get("machines", 1)["status"], "available")
        faults = self.svc.faults(open_only=True)
        self.assertTrue(any(f["kind"] == "scratch" for f in faults))

    def test_battery_swap_during_training_old_battery_charges(self):
        r = self._active()
        # 领用的是 BT1，换 BT2
        self.svc.swap_battery(r["id"], new_battery_id=2, reason="掉电")
        self.assertEqual(self.svc._get("batteries", 1)["status"], "charging")
        self.assertEqual(self.svc._get("batteries", 2)["status"], "in_use")
        detail = self.svc.session_detail(r["id"])
        self.assertEqual(detail["current_battery_id"], 2)
        # 归还时是当前电池（BT2）进入充电
        self.close(r, returned=60)
        self.assertEqual(self.svc._get("batteries", 2)["status"], "charging")
        self.assertEqual(self.svc._get("baskets", 1)["status"], "available")

    def test_cannot_return_without_checkout(self):
        r = self.book()
        with self.assertRaises(DomainError):
            self.close(r, returned=60)

    def test_negative_return_rejected(self):
        r = self._active()
        with self.assertRaises(DomainError):
            self.svc.return_equipment(r["id"], balls_returned=-1)

    def test_charge_completes_after_45_minutes(self):
        r = self._active()
        self.close(r, returned=60)
        self.assertEqual(self.svc._get("batteries", 1)["status"], "charging")
        self.clock.advance(minutes=44)
        self.assertEqual(self.svc.complete_charges(), [])
        self.clock.advance(minutes=2)
        self.assertEqual(self.svc.complete_charges(), [1])
        self.assertEqual(self.svc._get("batteries", 1)["status"], "charged")

    def test_reject_more_balls_than_issued_plus_tolerance(self):
        r = self._active()
        with self.assertRaises(DomainError):
            self.svc.return_equipment(r["id"], balls_returned=200)
