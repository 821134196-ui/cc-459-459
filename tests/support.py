"""unittest helpers: temp DB with a controllable fake clock."""
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path

from app.adapters import PaymentGateway, WeatherAdapter
from app.clock import Clock
from app.db import connect, init_db
from app.service import ClubService

T0 = datetime(2026, 9, 30, 10, 0)


class ClubTestCase(unittest.TestCase):
    def setUp(self):
        self._dir = tempfile.TemporaryDirectory()
        self.db_path = Path(self._dir.name) / "test.db"
        self.conn = connect(self.db_path)
        init_db(self.conn)
        self.clock = Clock(T0)
        self.weather = WeatherAdapter("sunny")
        self.payment = PaymentGateway()
        self.svc = ClubService(self.conn, self.clock,
                               weather=self.weather, payment=self.payment)
        self._seed_master()

    def tearDown(self):
        self.conn.close()
        self._dir.cleanup()

    def _seed_master(self):
        c = self.conn
        for i, name in enumerate(["会员甲", "会员乙", "会员丙", "会员丁"], start=1):
            c.execute("INSERT INTO members(id,name,level,phone) VALUES(?,?, '3.5','')",
                      (i, name))
        for i, code in enumerate(["C1", "C2", "C3"], start=1):
            c.execute("INSERT INTO courts(id,code) VALUES(?,?)", (i, code))
        for i, code in enumerate(["M1", "M2", "M3"], start=1):
            c.execute("INSERT INTO machines(id,code,model) VALUES(?,?,'X')", (i, code))
        for i, code in enumerate(["BT1", "BT2", "BT3", "BT4"], start=1):
            c.execute("INSERT INTO batteries(id,code,status) VALUES(?,?,'charged')",
                      (i, code))
        for i, code in enumerate(["BK1", "BK2", "BK3"], start=1):
            c.execute("INSERT INTO baskets(id,code,capacity) VALUES(?,?,60)", (i, code))
        c.commit()

    def book(self, *, start=None, end=None, court=1, machine=1, member=1,
             mode="固定点位", deposit=20000, allow_past=False):
        start = T0 + timedelta(hours=1) if start is None else start
        end = T0 + timedelta(hours=2) if end is None else end
        return self.svc.create_reservation(
            member_id=member, court_id=court, machine_id=machine,
            start=start, end=end, training_mode=mode, deposit=deposit,
            allow_past=allow_past)

    def checkin(self, r, *, battery=1, basket=1, balls=60):
        self.svc.checkout(r["id"], battery_id=battery, basket_id=basket,
                          balls_issued=balls, checker="前台")
        self.svc.start_training(r["id"])

    def close(self, r, returned=60, **kw):
        return self.svc.return_equipment(r["id"], balls_returned=returned, **kw)
