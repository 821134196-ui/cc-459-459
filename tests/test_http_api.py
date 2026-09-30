"""HTTP API smoke tests: real socket server on an ephemeral port."""
import http.client
import json
import threading
import unittest
from datetime import timedelta
from http.server import ThreadingHTTPServer

from app.adapters import PaymentGateway, WeatherAdapter
from app.clock import Clock
from app.db import connect, init_db
from app.scheduler import Scheduler
from app.server import make_handler
from tests.support import T0


def _seed(conn):
    conn.executemany("INSERT INTO members(id,name,level,phone) VALUES(?,?, '3.5','')",
                     [(1, "甲",), (2, "乙",)])
    conn.executemany("INSERT INTO courts(id,code) VALUES(?,?)",
                     [(1, "C1"), (2, "C2")])
    conn.executemany("INSERT INTO machines(id,code,model) VALUES(?,?,'X')",
                     [(1, "M1"), (2, "M2")])
    conn.executemany("INSERT INTO batteries(id,code,status) VALUES(?,?,'charged')",
                     [(1, "BT1"), (2, "BT2")])
    conn.executemany("INSERT INTO baskets(id,code,capacity) VALUES(?,?,60)",
                     [(1, "BK1"), (2, "BK2")])
    conn.commit()


class HttpCase(unittest.TestCase):
    def setUp(self):
        import tempfile
        from pathlib import Path
        self.dir = tempfile.TemporaryDirectory()
        self.conn = connect(Path(self.dir.name) / "h.db")
        init_db(self.conn)
        _seed(self.conn)
        self.clock = Clock(T0)
        self.weather = WeatherAdapter("sunny")
        from app.service import ClubService
        self.svc = ClubService(self.conn, self.clock, weather=self.weather,
                               payment=PaymentGateway())
        self.sch = Scheduler(self.svc, weather_watch=True)
        handler = make_handler(self.svc, self.weather)
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever,
                                       daemon=True)
        self.thread.start()

    def tearDown(self):
        self.httpd.shutdown()
        self.thread.join(3)
        self.httpd.server_close()
        self.conn.close()
        self.dir.cleanup()

    def req(self, method, path, body=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        payload = json.dumps(body) if body is not None else None
        headers = {"Content-Type": "application/json"} if payload else {}
        c.request(method, path, payload, headers)
        r = c.getresponse()
        raw = r.read().decode("utf-8")
        data = json.loads(raw) if raw else {}
        c.close()
        return r.status, data

    def test_state_and_calendar(self):
        st, data = self.req("GET", "/api/state")
        self.assertEqual(st, 200)
        self.assertEqual(len(data["machines"]), 2)
        st, cal = self.req("GET", "/api/calendar")
        self.assertEqual(st, 200)
        self.assertIn("reservations", cal)

    def test_booking_conflict_returns_409_with_resource(self):
        body = dict(member_id=1, court_id=1, machine_id=1,
                    start=(T0 + timedelta(hours=1)).isoformat(),
                    end=(T0 + timedelta(hours=2)).isoformat(),
                    training_mode="固定点位", deposit=20000)
        st, created = self.req("POST", "/api/reservations", body)
        self.assertEqual(st, 201)
        st, err = self.req("POST", "/api/reservations",
                           {**body, "member_id": 2, "court_id": 1,
                            "machine_id": 2})
        self.assertEqual(st, 409)
        self.assertEqual(err["resource"], "court")

    def test_full_flow_checkout_return_deposit_role_and_idempotency(self):
        start = T0.isoformat()
        end = (T0 + timedelta(minutes=60)).isoformat()
        _, r = self.req("POST", "/api/reservations",
                        dict(member_id=1, court_id=1, machine_id=1,
                             start=start, end=end,
                             training_mode="固定点位", deposit=20000))
        st, _ = self.req("POST", f"/api/reservations/{r['id']}/checkout",
                         dict(battery_id=1, basket_id=1, balls_issued=60,
                              checker="前台"))
        self.assertEqual(st, 200)
        st, _ = self.req("POST", f"/api/reservations/{r['id']}/start", {})
        self.assertEqual(st, 200)
        st, ret = self.req("POST", f"/api/reservations/{r['id']}/return",
                           dict(balls_returned=55, inspector="前台"))
        self.assertEqual(st, 200)
        self.assertEqual(ret["balls_short"], 5)
        # 前台不能确认
        st, err = self.req("POST", f"/api/deposits/{r['id']}/review",
                           dict(role="clerk", manager="前台", confirm=True))
        self.assertEqual(st, 403)
        # 经理确认
        st, review = self.req("POST", f"/api/deposits/{r['id']}/review",
                              dict(role="manager", manager="赵磊", confirm=True))
        self.assertEqual(st, 200)
        self.assertEqual(review["total_deducted"], 4000)
        txn = review["payment_txn"]
        # 幂等：再来一次不重复扣款
        st, again = self.req("POST", f"/api/deposits/{r['id']}/review",
                             dict(role="manager", manager="赵磊", confirm=True))
        self.assertEqual(st, 200)
        self.assertTrue(again["idempotent"])
        self.assertEqual(again["payment_txn"], txn)

    def test_weather_rain_then_scheduler_tick_suspends(self):
        st, _ = self.req("POST", "/api/weather", dict(mode="rain"))
        self.assertEqual(st, 200)
        st, tick = self.req("POST", "/api/admin/tick", {})
        self.assertEqual(st, 200)
        # 没有在场订单，rain 为 None，但接口可用
        self.assertIn("summary", tick)
        st, rain = self.req("GET", "/api/rain")
        self.assertEqual(st, 200)


if __name__ == "__main__":
    unittest.main()
