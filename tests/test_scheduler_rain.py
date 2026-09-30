"""迟到释放、雨天停场/恢复、后台调度器。"""
from datetime import timedelta

from app.clock import iso
from app.scheduler import Scheduler
from tests.support import T0, ClubTestCase


class TestSchedulerAndRain(ClubTestCase):
    def test_late_release_via_scheduler_tick(self):
        r = self.book(start=T0 - timedelta(minutes=5),
                      end=T0 + timedelta(minutes=55), allow_past=True)
        sch = Scheduler(self.svc, interval_sec=999, weather_watch=False)
        self.clock.advance(minutes=16)
        summary = sch.tick()
        self.assertEqual(summary["late_released"], [r["id"]])
        self.assertEqual(self.svc._get("reservations", r["id"])["status"],
                         "late_released")

    def test_charge_completion_via_scheduler_tick(self):
        r = self.book(start=T0 - timedelta(minutes=20),
                      end=T0 + timedelta(minutes=40), allow_past=True)
        self.checkin(r)
        self.close(r)
        self.assertEqual(self.svc._get("batteries", 1)["status"], "charging")
        sch = Scheduler(self.svc, weather_watch=False)
        self.clock.advance(minutes=46)
        self.assertEqual(sch.tick()["charges_completed"], [1])

    def test_weather_adapter_auto_suspends_and_resumes(self):
        # 一个进行中的订单
        active = self.book(start=T0 - timedelta(minutes=10),
                           end=T0 + timedelta(minutes=50), allow_past=True,
                           court=1, machine=1)
        self.checkin(active)
        # 一个 2 小时后的订单（不应被雨停挂起）
        later = self.book(start=T0 + timedelta(hours=2),
                          end=T0 + timedelta(hours=3),
                          court=2, machine=2, member=2)
        sch = Scheduler(self.svc, weather_watch=True)
        self.weather.set_mode("rain")
        out = sch.tick()["rain"]
        self.assertEqual(out["type"], "suspend")
        self.assertEqual(self.svc._get("reservations", active["id"])["status"],
                         "rain_suspended")
        self.assertEqual(self.svc._get("reservations", later["id"])["status"],
                         "booked")
        self.assertEqual(self.svc._get("courts", 1)["status"], "suspended")

        # 雨停，进行中订单恢复原状态
        self.weather.set_mode("sunny")
        out = sch.tick()["rain"]
        self.assertEqual(out["type"], "resume")
        self.assertEqual(out["restored"], 1)
        self.assertEqual(self.svc._get("reservations", active["id"])["status"],
                         "active")
        self.assertEqual(self.svc._get("courts", 1)["status"], "open")

    def test_rain_resume_after_slot_end_releases_and_frees_gear(self):
        r = self.book(start=T0 - timedelta(minutes=40),
                      end=T0 + timedelta(minutes=20), allow_past=True)
        self.checkin(r)
        self.svc.rain_suspend_all("暴雨")
        self.clock.advance(minutes=30)  # 时段已过
        self.assertEqual(self.svc._get("reservations", r["id"])["status"],
                         "rain_suspended")
        out = self.svc.rain_resume()
        self.assertEqual(out["released"], 1)
        self.assertEqual(self.svc._get("reservations", r["id"])["status"],
                         "late_released")
        # 未归还的设备被后台释放：球筐可用、电池充电、机器可用
        self.assertEqual(self.svc._get("baskets", 1)["status"], "available")
        self.assertEqual(self.svc._get("batteries", 1)["status"], "charging")
        self.assertEqual(self.svc._get("machines", 1)["status"], "available")

    def test_rain_suspended_session_can_return_and_close(self):
        r = self.book(start=T0 - timedelta(minutes=20),
                      end=T0 + timedelta(minutes=40), allow_past=True)
        self.checkin(r)
        self.svc.rain_suspend_all("暴雨")
        out = self.svc.return_equipment(r["id"], balls_returned=58,
                                        note="雨停提前收场")
        self.assertEqual(out["status"], "rain_closed")
        self.assertEqual(out["balls_short"], 2)

    def test_second_suspend_while_active_rejected(self):
        self.svc.rain_suspend_all("暴雨")
        with self.assertRaises(Exception):
            self.svc.rain_suspend_all("再停")
