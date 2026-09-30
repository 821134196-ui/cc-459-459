"""资源双重锁定：两个订单不能占用同一球场或机器的重叠时段。"""
from datetime import timedelta

from app.clock import iso
from app.errors import DomainError, ResourceConflict
from tests.support import T0, ClubTestCase


class TestDoubleLock(ClubTestCase):
    def test_overlapping_court_rejected_even_with_other_machine(self):
        self.book(court=1, machine=1,
                  start=T0 + timedelta(hours=1), end=T0 + timedelta(hours=2))
        with self.assertRaises(ResourceConflict) as cm:
            self.book(court=1, machine=2, member=2,
                      start=T0 + timedelta(hours=1, minutes=30),
                      end=T0 + timedelta(hours=2, minutes=30))
        self.assertEqual(cm.exception.resource, "court")

    def test_overlapping_machine_rejected_even_on_other_court(self):
        self.book(court=1, machine=1)
        with self.assertRaises(ResourceConflict) as cm:
            self.book(court=2, machine=1, member=2,
                      start=T0 + timedelta(hours=1), end=T0 + timedelta(hours=2))
        self.assertEqual(cm.exception.resource, "machine")

    def test_partial_overlap_both_directions(self):
        self.book(start=T0 + timedelta(hours=1), end=T0 + timedelta(hours=2))
        # 头部相交（同球场、不同机器）
        with self.assertRaises(ResourceConflict):
            self.book(court=1, machine=2, member=2,
                      start=T0 + timedelta(minutes=45),
                      end=T0 + timedelta(hours=1, minutes=15))
        # 尾部相交（同机器、不同球场）
        with self.assertRaises(ResourceConflict):
            self.book(court=2, machine=1, member=2,
                      start=T0 + timedelta(hours=1, minutes=50),
                      end=T0 + timedelta(hours=2, minutes=20))

    def test_back_to_back_allowed_half_open_interval(self):
        self.book(start=T0 + timedelta(hours=1), end=T0 + timedelta(hours=2))
        # 首尾相接（end == next start）不算重叠
        nxt = self.book(court=1, machine=1, member=2,
                        start=T0 + timedelta(hours=2), end=T0 + timedelta(hours=3))
        self.assertEqual(nxt["status"], "booked")

    def test_different_court_and_machine_parallel_allowed(self):
        self.book(court=1, machine=1)
        other = self.book(court=2, machine=2, member=2)
        self.assertEqual(other["status"], "booked")

    def test_closed_session_releases_both_resources(self):
        r = self.book(start=T0 - timedelta(minutes=30),
                      end=T0 + timedelta(minutes=30), allow_past=True)
        self.checkin(r)
        self.close(r, returned=60)
        # 同一球场+机器的新预约（与旧窗口重叠）现在可以建
        again = self.book(court=1, machine=1, member=2,
                          start=T0 - timedelta(minutes=10),
                          end=T0 + timedelta(minutes=20), allow_past=True)
        self.assertEqual(again["status"], "booked")

    def test_late_released_order_no_longer_locks(self):
        r = self.book(start=T0 - timedelta(minutes=30), end=T0 + timedelta(minutes=30),
                      allow_past=True)
        # 超过 10 分钟宽限未领用
        self.clock.advance(minutes=12)
        self.assertEqual(self.svc.release_late(), [r["id"]])
        again = self.book(court=1, machine=1, member=2,
                          start=T0 + timedelta(minutes=1),
                          end=T0 + timedelta(minutes=20), allow_past=True)
        self.assertEqual(again["status"], "booked")

    def test_within_grace_still_locks(self):
        self.book(start=T0 - timedelta(minutes=5), end=T0 + timedelta(minutes=55),
                  allow_past=True)
        self.clock.advance(minutes=4)
        self.assertEqual(self.svc.release_late(), [])
        with self.assertRaises(ResourceConflict):
            self.book(court=1, machine=2, member=2,
                      start=T0 + timedelta(minutes=1),
                      end=T0 + timedelta(minutes=30), allow_past=True)

    def test_cannot_book_past_slot(self):
        with self.assertRaises(DomainError):
            self.book(start=T0 - timedelta(hours=1), end=T0)
