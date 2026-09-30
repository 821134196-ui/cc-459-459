"""续场边界：续场必须重新检查球场与发球机的后续预约。"""
from datetime import timedelta

from app.clock import iso
from app.errors import DomainError, ResourceConflict
from tests.support import T0, ClubTestCase


class TestExtension(ClubTestCase):
    def _active(self, end):
        r = self.book(start=T0 - timedelta(minutes=30), end=end,
                      allow_past=True)
        self.checkin(r)
        return r

    def test_extend_blocked_at_exact_overlap_with_next_court_booking(self):
        # 当前 [09:30, 10:30]，后续同球场订单 10:30 开始
        a = self._active(T0 + timedelta(minutes=30))
        self.book(court=1, machine=2, member=2,
                  start=T0 + timedelta(minutes=30), end=T0 + timedelta(minutes=90))
        # +1 分钟即与后续订单相交 → 拒绝
        with self.assertRaises(ResourceConflict) as cm:
            self.svc.extend_reservation(a["id"], 1)
        self.assertEqual(cm.exception.resource, "court")

    def test_extend_to_exact_next_start_allowed_half_open(self):
        a = self._active(T0 + timedelta(minutes=30))
        self.book(court=1, machine=2, member=2,
                  start=T0 + timedelta(minutes=60), end=T0 + timedelta(minutes=90))
        # 续到 10:30 == 后续开始，半开区间不冲突
        out = self.svc.extend_reservation(a["id"], 30)
        self.assertEqual(out["end_ts"], iso(T0 + timedelta(minutes=60)))
        # 再续 1 分钟就冲突
        with self.assertRaises(ResourceConflict):
            self.svc.extend_reservation(a["id"], 1)

    def test_extend_checks_machine_too(self):
        a = self._active(T0 + timedelta(minutes=30))
        # 后续用同一机器、不同球场
        self.book(court=2, machine=1, member=2,
                  start=T0 + timedelta(minutes=45), end=T0 + timedelta(minutes=90))
        with self.assertRaises(ResourceConflict) as cm:
            self.svc.extend_reservation(a["id"], 20)
        self.assertEqual(cm.exception.resource, "machine")

    def test_extend_free_window_succeeds_and_updates_end(self):
        a = self._active(T0 + timedelta(minutes=30))
        out = self.svc.extend_reservation(a["id"], 45)
        self.assertEqual(out["status"], "extended")
        self.assertEqual(out["end_ts"], iso(T0 + timedelta(minutes=75)))

    def test_extend_then_new_booking_respects_new_boundary(self):
        a = self._active(T0 + timedelta(minutes=30))
        self.svc.extend_reservation(a["id"], 30)  # 到 11:00
        # 10:30–11:00 的新订单（同球场）必须被续后的边界挡住
        with self.assertRaises(ResourceConflict):
            self.book(court=1, machine=2, member=2,
                      start=T0 + timedelta(minutes=45),
                      end=T0 + timedelta(minutes=55))
        # 11:00 起则可以
        ok = self.book(court=1, machine=2, member=2,
                       start=T0 + timedelta(minutes=60),
                       end=T0 + timedelta(minutes=90))
        self.assertEqual(ok["status"], "booked")

    def test_extend_rejects_bad_minutes_and_wrong_status(self):
        future = self.book()  # booked, not active
        with self.assertRaises(DomainError):
            self.svc.extend_reservation(future["id"], 30)
        a = self._active(T0 + timedelta(minutes=30))
        with self.assertRaises(DomainError):
            self.svc.extend_reservation(a["id"], 0)
        with self.assertRaises(DomainError):
            self.svc.extend_reservation(a["id"], 200)

    def test_cannot_extend_after_close(self):
        a = self._active(T0 + timedelta(minutes=30))
        self.close(a)
        with self.assertRaises(DomainError):
            self.svc.extend_reservation(a["id"], 30)
