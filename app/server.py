"""Zero-dependency HTTP server: JSON API + static web/ and data/photos."""
from __future__ import annotations

import argparse
import cgi
import json
import logging
import mimetypes
import re
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from .adapters import PaymentGateway, WeatherAdapter
from .clock import Clock, parse
from .db import connect, init_db
from .errors import DomainError, Forbidden, NotFound, ResourceConflict
from .scheduler import Scheduler
from .seed import DB_PATH, PHOTO_DIR, build
from .service import TRAINING_MODES, ClubService

ROOT = Path(__file__).resolve().parent.parent
WEB_DIR = ROOT / "web"

log = logging.getLogger("server")


def _dt(body: dict, key: str) -> datetime:
    val = body.get(key)
    if not val:
        raise DomainError(f"缺少时间字段 {key}")
    try:
        s = str(val).replace("Z", "")
        return parse(s)
    except ValueError as e:
        raise DomainError(f"时间格式错误: {val}（需要 YYYY-MM-DDTHH:MM）") from e


def make_handler(svc: ClubService, weather: WeatherAdapter):
    class Handler(BaseHTTPRequestHandler):
        server_version = "TennisClub/1.0"

        # ------------------------------------------------------------ plumbing
        def _send_json(self, obj, status: int = 200) -> None:
            data = json.dumps(obj, ensure_ascii=False, default=str).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def _send_file(self, path: Path) -> None:
            if not path.is_file():
                self._send_json({"error": "文件不存在"}, 404)
                return
            ctype = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
            data = path.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(data)

        def _body(self) -> dict:
            length = int(self.headers.get("Content-Length") or 0)
            if not length:
                return {}
            raw = self.rfile.read(length)
            try:
                return json.loads(raw.decode("utf-8"))
            except (json.JSONDecodeError, UnicodeDecodeError) as e:
                raise DomainError(f"请求体不是合法 JSON: {e}") from e

        def _query(self) -> dict:
            q = parse_qs(urlparse(self.path).query)
            return {k: v[0] for k, v in q.items()}

        def log_message(self, fmt, *args):  # quiet + structured
            log.info("%s - %s", self.address_string(), fmt % args)

        # ---------------------------------------------------------------- GET
        def do_GET(self) -> None:
            try:
                path = urlparse(self.path).path
                if path in ("/", "/index.html"):
                    return self._send_file(WEB_DIR / "index.html")
                if path.startswith("/web/"):
                    return self._send_file(WEB_DIR / path.removeprefix("/web/"))
                if path.startswith("/photos/"):
                    name = Path(path.removeprefix("/photos/")).name
                    return self._send_file(PHOTO_DIR / name)
                if path == "/api/state":
                    eq = svc.equipment_table()
                    return self._send_json({
                        **eq, "members": svc.members(),
                        "training_modes": TRAINING_MODES,
                        "rain": svc.rain_status(),
                    })
                if path == "/api/calendar":
                    return self._send_json(svc.calendar(self._query().get("day")))
                if path == "/api/sessions/open":
                    return self._send_json({"sessions": svc.reservations_open()})
                if path == "/api/faults":
                    return self._send_json(
                        {"faults": svc.faults(self._query().get("open") == "1")})
                if path == "/api/rain":
                    return self._send_json(svc.rain_status())
                if path == "/api/deposits/pending":
                    return self._send_json({"reviews": svc.pending_deposit_reviews()})
                if path == "/api/deposits":
                    return self._send_json({"reviews": svc.deposit_reviews()})
                if path == "/api/photos":
                    q = self._query()
                    return self._send_json({"photos": svc.list_photos(
                        q.get("type"), int(q["ref"]) if q.get("ref") else None)})
                m = re.fullmatch(r"/api/session/(\d+)", path)
                if m:
                    return self._send_json(svc.session_detail(int(m.group(1))))
                self._send_json({"error": "未知接口"}, 404)
            except (DomainError,) as e:
                self._domain_error(e)
            except Exception:
                log.exception("GET %s failed", self.path)
                self._send_json({"error": "服务器内部错误"}, 500)

        # --------------------------------------------------------------- POST
        def do_POST(self) -> None:
            try:
                path = urlparse(self.path).path
                body = self._body()

                if path == "/api/reservations":
                    res = svc.create_reservation(
                        member_id=int(body["member_id"]),
                        court_id=int(body["court_id"]),
                        machine_id=int(body["machine_id"]),
                        start=_dt(body, "start"), end=_dt(body, "end"),
                        training_mode=body["training_mode"],
                        deposit=int(body.get("deposit", 20000)))
                    return self._send_json(res, 201)

                m = re.fullmatch(r"/api/reservations/(\d+)/extend", path)
                if m:
                    return self._send_json(
                        svc.extend_reservation(int(m.group(1)),
                                               int(body["minutes"])))
                m = re.fullmatch(r"/api/reservations/(\d+)/cancel", path)
                if m:
                    return self._send_json(svc.cancel_reservation(int(m.group(1))))
                m = re.fullmatch(r"/api/reservations/(\d+)/checkout", path)
                if m:
                    return self._send_json(svc.checkout(
                        int(m.group(1)), battery_id=int(body["battery_id"]),
                        basket_id=int(body["basket_id"]),
                        balls_issued=int(body["balls_issued"]),
                        checker=body.get("checker", "前台")))
                m = re.fullmatch(r"/api/reservations/(\d+)/start", path)
                if m:
                    return self._send_json(svc.start_training(int(m.group(1))))
                m = re.fullmatch(r"/api/reservations/(\d+)/swap-battery", path)
                if m:
                    return self._send_json(svc.swap_battery(
                        int(m.group(1)), int(body["battery_id"]),
                        body.get("reason", "掉电")))
                m = re.fullmatch(r"/api/reservations/(\d+)/return", path)
                if m:
                    return self._send_json(svc.return_equipment(
                        int(m.group(1)),
                        balls_returned=int(body["balls_returned"]),
                        scratch_fen=int(body.get("scratch_fen", 0)),
                        jammed=bool(body.get("jammed")),
                        battery_replaced=bool(body.get("battery_replaced")),
                        inspector=body.get("inspector", "前台"),
                        note=body.get("note", "")))
                if path == "/api/faults":
                    return self._send_json(svc.report_fault(
                        int(body["machine_id"]), body.get("kind", "other"),
                        body["description"],
                        body.get("reservation_id"),
                        maintain=bool(body.get("maintain", True))), 201)
                m = re.fullmatch(r"/api/faults/(\d+)/repair", path)
                if m:
                    return self._send_json(svc.repair_fault(
                        int(m.group(1)), body["resolution"],
                        body.get("mechanic", "机修-李工")))
                if path == "/api/rain/suspend":
                    return self._send_json(svc.rain_suspend_all(
                        body.get("reason", "手动停场")))
                if path == "/api/rain/resume":
                    return self._send_json(svc.rain_resume())
                if path == "/api/weather":
                    mode = body.get("mode", "sunny")
                    weather.set_mode(mode)
                    return self._send_json({"mode": mode,
                                            "forecast": weather.forecast()})
                m = re.fullmatch(r"/api/deposits/(\d+)/review", path)
                if m:
                    return self._send_json(svc.review_deposit(
                        int(m.group(1)), role=body.get("role", "clerk"),
                        manager=body.get("manager", ""),
                        balls_fee=body.get("balls_fee"),
                        scratch_fee=body.get("scratch_fee"),
                        other_fee=int(body.get("other_fee", 0)),
                        confirm=bool(body.get("confirm"))))
                if path == "/api/photos":
                    return self._handle_photo_upload()
                if path == "/api/admin/tick":
                    # demo/tests: run one scheduler pass immediately
                    sched = _SCHEDULER or Scheduler(svc, weather_watch=True)
                    return self._send_json({"ran": True, "summary": sched.tick()})

                self._send_json({"error": "未知接口"}, 404)
            except (DomainError,) as e:
                self._domain_error(e)
            except KeyError as e:
                self._send_json({"error": f"缺少字段: {e.args[0]}"}, 400)
            except (TypeError, ValueError) as e:
                self._send_json({"error": f"参数错误: {e}"}, 400)
            except Exception:
                log.exception("POST %s failed", self.path)
                self._send_json({"error": "服务器内部错误"}, 500)

        def _domain_error(self, e: DomainError) -> None:
            if isinstance(e, NotFound):
                return self._send_json({"error": str(e)}, 404)
            if isinstance(e, Forbidden):
                return self._send_json({"error": str(e)}, 403)
            if isinstance(e, ResourceConflict):
                return self._send_json(
                    {"error": str(e), "resource": e.resource,
                     "conflicting": e.conflicting, "code": "conflict"}, 409)
            self._send_json({"error": str(e)}, 400)

        # ------------------------------------------------------------- upload
        def _handle_photo_upload(self):
            ctype = self.headers.get("Content-Type", "")
            if "multipart/form-data" not in ctype:
                raise DomainError("照片上传需使用 multipart/form-data")
            form = cgi.FieldStorage(fp=self.rfile, headers=self.headers,
                                    environ={"REQUEST_METHOD": "POST",
                                             "CONTENT_TYPE": ctype})
            ref_type = form.getvalue("ref_type")
            ref_id = int(form.getvalue("ref_id"))
            label = form.getvalue("label", "")
            item = form["file"]
            filename = Path(item.filename).name
            if not filename:
                raise DomainError("缺少文件")
            dest = PHOTO_DIR / filename
            dest.write_bytes(item.file.read())
            return self._send_json(svc.add_photo(ref_type, ref_id, filename,
                                                 label), 201)

    return Handler


# module-level scheduler handle so /api/admin/tick can trigger it
_SCHEDULER: Scheduler | None = None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--db", default=str(DB_PATH))
    ap.add_argument("--reset", action="store_true")
    ap.add_argument("--seed", action="store_true")
    ap.add_argument("--no-scheduler", action="store_true")
    ap.add_argument("--weather", default="rain",
                    choices=["sunny", "cloudy", "rain"])
    args = ap.parse_args()

    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    conn = connect(args.db)
    init_db(conn)
    clock = Clock()
    weather, payment = WeatherAdapter(args.weather), PaymentGateway()
    svc = ClubService(conn, clock, weather=weather, payment=payment)
    if args.reset:
        from .seed import reset_db
        reset_db()
        conn.close()
        conn = connect(args.db)
        init_db(conn)
        svc = ClubService(conn, clock, weather=weather, payment=payment)
    if args.seed or args.reset:
        build(conn, clock, weather, payment, verbose=True)

    global _SCHEDULER
    _SCHEDULER = Scheduler(svc)
    if not args.no_scheduler:
        _SCHEDULER.start()

    handler = make_handler(svc, weather)
    httpd = ThreadingHTTPServer((args.host, args.port), handler)
    print(f"🎾 网球俱乐部系统已启动: http://{args.host}:{args.port}")
    print("   Ctrl+C 退出")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n正在关闭…")
    finally:
        _SCHEDULER.stop()
        httpd.server_close()


if __name__ == "__main__":
    main()
