"""Demo seed data.

Running `python3 -m app.seed --reset` (also done by ./run.sh) produces,
relative to the current clock:
  * a confirmed booking + two rejected double-lock attempts (court overlap,
    machine overlap) — printed as the 预约冲突样例;
  * an active session parked under a rain stop — 雨停样例;
  * a closed session short 6 balls, awaiting the manager's deposit review —
    球数短缺样例;
  * one machine under repair and one battery mid-charge (allocation blocks).
"""
from __future__ import annotations

import argparse
import sqlite3
from datetime import timedelta
from pathlib import Path

from .adapters import PaymentGateway, WeatherAdapter
from .clock import Clock, iso
from .db import connect, init_db
from .errors import ResourceConflict
from .service import CHARGE_MINUTES, ClubService

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = ROOT / "data" / "club.db"
PHOTO_DIR = ROOT / "data" / "photos"

DEPOSIT = 200_00  # ¥200 in fen

PLACEHOLDERS = {
    "machine": '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200">'
               '<rect width="320" height="200" fill="#3a6f3a"/>'
               '<rect x="110" y="40" width="100" height="120" rx="14" fill="#f5f1e8" stroke="#9e3b2e" stroke-width="4"/>'
               '<circle cx="160" cy="100" r="26" fill="#9e3b2e"/>'
               '<text x="160" y="188" font-size="16" text-anchor="middle" fill="#fff" font-family="sans-serif">{label}</text></svg>',
    "basket": '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200">'
              '<rect width="320" height="200" fill="#2f5d8a"/>'
              '<path d="M80 60 L240 60 L220 170 L100 170 Z" fill="#d9a441" stroke="#8a5e16" stroke-width="4"/>'
              '<ellipse cx="160" cy="60" rx="80" ry="14" fill="none" stroke="#8a5e16" stroke-width="4"/>'
              '<text x="160" y="125" font-size="22" text-anchor="middle" fill="#3a2a08" font-family="sans-serif">{label}</text></svg>',
}


def _placeholder(kind: str, code: str) -> str:
    return f"{kind}-{code.lower()}.svg", PLACEHOLDERS[kind].format(label=code)


def build(conn: sqlite3.Connection, clock: Clock, weather: WeatherAdapter,
          payment: PaymentGateway, verbose: bool = True) -> ClubService:
    init_db(conn)
    svc = ClubService(conn, clock, weather=weather, payment=payment)

    def log(msg: str) -> None:
        if verbose:
            print(msg)

    # ---- master data
    members = [
        ("林晓彤", "3.5", "138-0000-0001"),
        ("陈牧", "4.0", "138-0000-0002"),
        ("周岚", "3.0", "138-0000-0003"),
        ("高远", "4.5", "138-0000-0004"),
    ]
    for i, (name, level, phone) in enumerate(members, start=1):
        conn.execute("INSERT OR IGNORE INTO members(id,name,level,phone) VALUES(?,?,?,?)",
                     (i, name, level, phone))
    for i, code in enumerate(["C1", "C2", "C3"], start=1):
        conn.execute("INSERT OR IGNORE INTO courts(id,code,surface,status) VALUES(?,?, '硬地','open')",
                     (i, code))
    for i, code in enumerate(["M1", "M2", "M3", "M4", "M5"], start=1):
        conn.execute("INSERT OR IGNORE INTO machines(id,code,model,status) VALUES(?,?,?, 'available')",
                     (i, code, "TurfPro 3000"))
    batteries = [("BT1", "charged", None),
                 ("BT2", "charging", iso(clock.now() + timedelta(minutes=25))),
                 ("BT3", "charged", None),
                 ("BT4", "charged", None),
                 ("BT5", "charged", None),
                 ("BT6", "charged", None)]
    for i, (code, st, ready) in enumerate(batteries, start=1):
        conn.execute(
            "INSERT OR IGNORE INTO batteries(id,code,status,charge_ready_ts) VALUES(?,?,?,?)",
            (i, code, st, ready))
    for i, code in enumerate(["BK1", "BK2", "BK3", "BK4", "BK5"], start=1):
        conn.execute("INSERT OR IGNORE INTO baskets(id,code,capacity,status) VALUES(?,?,60,'available')",
                     (i, code))
    conn.commit()

    # placeholder device photos
    PHOTO_DIR.mkdir(parents=True, exist_ok=True)
    for kind, codes in (("machine", ["M1", "M2", "M3", "M4", "M5"]),
                        ("basket", ["BK1", "BK2", "BK3", "BK4", "BK5"])):
        for idx, code in enumerate(codes, start=1):
            fname, svg = _placeholder(kind, code)
            p = PHOTO_DIR / fname
            if not p.exists():
                p.write_text(svg, encoding="utf-8")
            svc.add_photo(kind, idx, fname, f"{code} 设备照")

    base = clock.now().replace(minute=0, second=0) + timedelta(hours=1)

    # ---- sample 1: confirmed booking A
    a_start, a_end = base + timedelta(minutes=30), base + timedelta(minutes=120)
    a = svc.create_reservation(member_id=1, court_id=1, machine_id=1,
                               start=a_start, end=a_end,
                               training_mode="固定点位", deposit=DEPOSIT)
    log(f"样例①预约成功：{a['code']}  C1+M1  {iso(a_start)[11:16]}-{iso(a_end)[11:16]}")

    # rejected: same court overlap (different machine)
    try:
        svc.create_reservation(member_id=2, court_id=1, machine_id=2,
                               start=a_start + timedelta(minutes=30),
                               end=a_end + timedelta(minutes=30),
                               training_mode="全场随机", deposit=DEPOSIT)
    except ResourceConflict as e:
        log(f"样例①冲突拦截（球场双重锁定）：{e}")
    # rejected: same machine overlap (different court)
    try:
        svc.create_reservation(member_id=3, court_id=2, machine_id=1,
                               start=a_start, end=a_end,
                               training_mode="发球专项", deposit=DEPOSIT)
    except ResourceConflict as e:
        log(f"样例①冲突拦截（发球机双重锁定）：{e}")
    # accepted: different court + different machine, same window
    b = svc.create_reservation(member_id=2, court_id=2, machine_id=2,
                               start=a_start, end=a_end,
                               training_mode="全场随机", deposit=DEPOSIT)
    log(f"样例①并行预约：{b['code']}  C2+M2 同时段（资源不重叠，允许）")

    # ---- sample 2 (built first so it closes before rain): shortage
    d_start = clock.now() - timedelta(minutes=80)
    d_end = clock.now() + timedelta(minutes=10)
    d = svc.create_reservation(member_id=4, court_id=2, machine_id=5,
                               start=d_start, end=d_end,
                               training_mode="高压截击", deposit=DEPOSIT,
                               allow_past=True)
    svc.checkout(d["id"], battery_id=4, basket_id=4, balls_issued=60,
                 checker="前台-王敏")
    svc.start_training(d["id"])
    ret = svc.return_equipment(d["id"], balls_returned=54, jammed=False,
                               inspector="前台-王敏",
                               note="底线草丛找回 0 颗，短缺 6 颗待经理复核")
    log(f"样例③球数短缺：{ret['code']} 领用60 归还54 短缺6，"
        f"电池BT4进入充电({CHARGE_MINUTES}分钟)，待押金复核")

    # ---- machine under repair (jammed), blocks allocation
    svc.report_fault(3, "jam", "样例：出球通道卡球，等待拆机清理",
                     maintain=True)
    log("维修阻断样例：M3 卡球维修中（预约将被拒绝分配）")

    # ---- sample 3: active session then rain stop
    c_start = clock.now() - timedelta(minutes=25)
    c_end = clock.now() + timedelta(minutes=65)
    c = svc.create_reservation(member_id=3, court_id=3, machine_id=4,
                               start=c_start, end=c_end,
                               training_mode="发球专项", deposit=DEPOSIT,
                               allow_past=True)
    svc.checkout(c["id"], battery_id=3, basket_id=3, balls_issued=60,
                 checker="前台-王敏")
    svc.start_training(c["id"])
    weather.set_mode("rain")
    rain = svc.rain_suspend_all("样例：突发阵雨，全场停场")
    log(f"样例②雨天停场：{rain['suspended']} 个在场预约挂起（含进行中的 {c['code']}），"
        "雨停后可恢复或自动释放")

    conn.commit()
    return svc


def reset_db() -> None:
    for suffix in ("", "-wal", "-shm"):
        p = Path(str(DB_PATH) + suffix)
        if p.exists():
            p.unlink()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--reset", action="store_true", help="删除旧库后重建")
    ap.add_argument("--db", default=str(DB_PATH))
    args = ap.parse_args()
    if args.reset:
        reset_db()
    conn = connect(args.db)
    clock = Clock()
    weather, payment = WeatherAdapter("rain"), PaymentGateway()
    print("=" * 64)
    print("种子数据生成：会员与费用均为演示数据，金额单位：分")
    print("=" * 64)
    build(conn, clock, weather, payment)
    print("=" * 64)
    print(f"数据库：{args.db}    照片目录：{PHOTO_DIR}")
    print("启动：./run.sh   （默认 http://127.0.0.1:8000）")


if __name__ == "__main__":
    main()
