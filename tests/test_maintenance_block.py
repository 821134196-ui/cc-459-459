"""维修阻断 + 充电未完成不可分配。"""
from datetime import timedelta

from app.errors import ResourceConflict
from tests.support import T0, ClubTestCase


class TestMaintenanceBlock(ClubTestCase):
    def test_machine_under_repair_cannot_be_booked(self):
        self.svc.report_fault(1, "jam", "卡球拆机")
        with self.assertRaises(ResourceConflict) as cm:
            self.book(court=1, machine=1)
        self.assertEqual(cm.exception.resource, "machine")

    def test_repair_with_remaining_open_fault_keeps_maintenance(self):
        self.svc.report_fault(1, "jam", "卡球")
        second = self.svc.report_fault(1, "other", "轮子异响")
        open_faults = self.svc.faults(open_only=True)
        first_id = next(f["id"] for f in open_faults
                        if f["description"] == "卡球")
        self.svc.repair_fault(first_id, "清理通道", "李工")
        # 仍有未决故障 → 保持维修中
        self.assertEqual(self.svc._get("machines", 1)["status"], "maintenance")
        self.svc.repair_fault(second["id"], "换轮", "李工")
        self.assertEqual(self.svc._get("machines", 1)["status"], "available")

    def test_charging_battery_cannot_be_checked_out(self):
        r = self.book(start=T0 - timedelta(minutes=20),
                      end=T0 + timedelta(minutes=40), allow_past=True)
        # BT1 充电中
        self.conn.execute(
            "UPDATE batteries SET status='charging', charge_ready_ts=? WHERE id=1",
            (iso_(30),))
        with self.assertRaises(ResourceConflict) as cm:
            self.svc.checkout(r["id"], battery_id=1, basket_id=1,
                              balls_issued=60, checker="前台")
        self.assertEqual(cm.exception.resource, "battery")

    def test_busy_basket_cannot_be_double_issued(self):
        a = self.book(start=T0 - timedelta(minutes=20),
                      end=T0 + timedelta(minutes=40), allow_past=True)
        self.checkin(a, battery=1, basket=1)
        b = self.book(court=2, machine=2, member=2,
                      start=T0 - timedelta(minutes=10),
                      end=T0 + timedelta(minutes=20), allow_past=True)
        with self.assertRaises(ResourceConflict) as cm:
            self.svc.checkout(b["id"], battery_id=2, basket_id=1,
                              balls_issued=60, checker="前台")
        self.assertEqual(cm.exception.resource, "basket")

    def test_rain_suspended_court_blocks_new_booking(self):
        self.svc.rain_suspend_all("暴雨")
        with self.assertRaises(ResourceConflict):
            self.book(court=1, machine=1)


def iso_(minutes_ahead: int) -> str:
    from app.clock import iso
    return iso(T0 + timedelta(minutes=minutes_ahead))
