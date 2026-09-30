"""SQLite schema + connection management."""
from __future__ import annotations

import sqlite3
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS members (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    level       TEXT NOT NULL,
    phone       TEXT
);

CREATE TABLE IF NOT EXISTS courts (
    id          INTEGER PRIMARY KEY,
    code        TEXT NOT NULL UNIQUE,
    surface     TEXT NOT NULL DEFAULT '硬地',
    status      TEXT NOT NULL DEFAULT 'open'      -- open | suspended(rain)
);

CREATE TABLE IF NOT EXISTS machines (
    id          INTEGER PRIMARY KEY,
    code        TEXT NOT NULL UNIQUE,
    model       TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'available' -- available | in_use | maintenance | reserved
);

CREATE TABLE IF NOT EXISTS batteries (
    id              INTEGER PRIMARY KEY,
    code            TEXT NOT NULL UNIQUE,
    status          TEXT NOT NULL DEFAULT 'charged', -- charged | in_use | charging
    charge_ready_ts TEXT
);

CREATE TABLE IF NOT EXISTS baskets (
    id              INTEGER PRIMARY KEY,
    code            TEXT NOT NULL UNIQUE,
    capacity        INTEGER NOT NULL DEFAULT 60,
    status          TEXT NOT NULL DEFAULT 'available' -- available | in_use
);

CREATE TABLE IF NOT EXISTS reservations (
    id              INTEGER PRIMARY KEY,
    code            TEXT NOT NULL UNIQUE,
    member_id       INTEGER NOT NULL REFERENCES members(id),
    court_id        INTEGER NOT NULL REFERENCES courts(id),
    machine_id      INTEGER NOT NULL REFERENCES machines(id),
    start_ts        TEXT NOT NULL,               -- ISO local
    end_ts          TEXT NOT NULL,
    training_mode   TEXT NOT NULL,
    deposit         INTEGER NOT NULL,            -- 分
    status          TEXT NOT NULL DEFAULT 'booked',
        -- booked | checked_out | active | closed | late_released
        -- | extended | rain_suspended | rain_closed
    checked_out_ts  TEXT,
    released_at     TEXT,
    grace_minutes   INTEGER NOT NULL DEFAULT 10,
    prev_status     TEXT,
    note            TEXT DEFAULT '',
    created_ts      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_res_court   ON reservations(court_id, start_ts, end_ts);
CREATE INDEX IF NOT EXISTS idx_res_machine ON reservations(machine_id, start_ts, end_ts);
CREATE INDEX IF NOT EXISTS idx_res_status  ON reservations(status);

CREATE TABLE IF NOT EXISTS checkouts (
    id                  INTEGER PRIMARY KEY,
    reservation_id      INTEGER NOT NULL UNIQUE REFERENCES reservations(id),
    battery_id          INTEGER NOT NULL REFERENCES batteries(id),
    basket_id           INTEGER NOT NULL REFERENCES baskets(id),
    balls_issued        INTEGER NOT NULL,
    checkout_ts         TEXT NOT NULL,
    checker             TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS returns (
    id                  INTEGER PRIMARY KEY,
    reservation_id      INTEGER NOT NULL UNIQUE REFERENCES reservations(id),
    balls_returned      INTEGER NOT NULL,
    balls_short         INTEGER NOT NULL DEFAULT 0,
    scratch             INTEGER NOT NULL DEFAULT 0,  -- 设备刮伤赔偿(分)
    jammed              INTEGER NOT NULL DEFAULT 0,  -- 1 = 归还时卡球
    battery_replaced    INTEGER NOT NULL DEFAULT 0,  -- 1 = 训练中掉电换电
    return_ts           TEXT NOT NULL,
    inspector           TEXT NOT NULL,
    note                TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS battery_swaps (
    id              INTEGER PRIMARY KEY,
    reservation_id  INTEGER NOT NULL REFERENCES reservations(id),
    old_battery_id  INTEGER NOT NULL REFERENCES batteries(id),
    new_battery_id  INTEGER NOT NULL REFERENCES batteries(id),
    reason          TEXT NOT NULL,
    swap_ts         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS faults (
    id              INTEGER PRIMARY KEY,
    machine_id      INTEGER NOT NULL REFERENCES machines(id),
    reservation_id  INTEGER REFERENCES reservations(id),
    kind            TEXT NOT NULL,             -- jam | poweroff | scratch | other
    description     TEXT NOT NULL,
    reported_ts     TEXT NOT NULL,
    resolved_ts     TEXT,
    resolution      TEXT DEFAULT '',
    status          TEXT NOT NULL DEFAULT 'open'   -- open | repaired
);

CREATE TABLE IF NOT EXISTS deposit_reviews (
    id                  INTEGER PRIMARY KEY,
    reservation_id      INTEGER NOT NULL REFERENCES reservations(id),
    balls_fee           INTEGER NOT NULL DEFAULT 0,
    scratch_fee         INTEGER NOT NULL DEFAULT 0,
    other_fee           INTEGER NOT NULL DEFAULT 0,
    total_deducted      INTEGER NOT NULL DEFAULT 0,
    refunded            INTEGER NOT NULL DEFAULT 0,
    manager             TEXT NOT NULL,
    decided_ts          TEXT NOT NULL,
    payment_txn         TEXT,
    status              TEXT NOT NULL DEFAULT 'confirmed' -- confirmed
);

CREATE TABLE IF NOT EXISTS photos (
    id          INTEGER PRIMARY KEY,
    ref_type    TEXT NOT NULL,          -- machine | basket | court
    ref_id      INTEGER NOT NULL,
    path        TEXT NOT NULL,
    label       TEXT DEFAULT '',
    taken_ts    TEXT NOT NULL,
    UNIQUE(ref_type, ref_id, path)
);

CREATE TABLE IF NOT EXISTS rain_log (
    id          INTEGER PRIMARY KEY,
    started_ts  TEXT NOT NULL,
    ended_ts    TEXT,
    reason      TEXT NOT NULL
);
"""


def connect(db_path: str | Path) -> sqlite3.Connection:
    Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path), timeout=15, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 15000")
    return conn


def init_db(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA)
    conn.commit()
