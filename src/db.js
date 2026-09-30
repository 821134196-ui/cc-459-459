'use strict';

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const SCHEMA = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS courts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  surface TEXT NOT NULL DEFAULT '硬地',
  status TEXT NOT NULL DEFAULT 'active',          -- active | closed
  rain_suspended INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS machines (
  id TEXT PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ok',              -- ok | maintenance
  note TEXT
);

CREATE TABLE IF NOT EXISTS repairs (
  id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',            -- open | repaired
  reporter TEXT,
  repair_fee INTEGER NOT NULL DEFAULT 0,
  reported_at INTEGER NOT NULL,
  resolved_at INTEGER
);

CREATE TABLE IF NOT EXISTS batteries (
  id TEXT PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'ready',           -- ready | charging | in_use
  charge_pct INTEGER NOT NULL DEFAULT 100,
  charge_started_at INTEGER,
  charging_until INTEGER,
  swap_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS baskets (
  id TEXT PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  capacity INTEGER NOT NULL DEFAULT 60,
  status TEXT NOT NULL DEFAULT 'available'        -- available | in_use
);

CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT,
  level TEXT,
  deposit_balance INTEGER NOT NULL DEFAULT 300
);

CREATE TABLE IF NOT EXISTS training_modes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  balls_per_hour INTEGER NOT NULL,
  fee_per_hour INTEGER NOT NULL,
  note TEXT
);

-- 预约即订单。confirmed/issued/rain_stopped 占用球场与发球机；
-- released(迟到释放)/returned/settled/cancelled 不再占用。
CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  member_id TEXT NOT NULL,
  court_id TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'confirmed',
  training_mode_id TEXT,
  battery_id TEXT,
  basket_id TEXT,
  balls_issued INTEGER NOT NULL DEFAULT 0,
  balls_returned INTEGER,
  deposit_held INTEGER NOT NULL DEFAULT 0,
  fee INTEGER NOT NULL DEFAULT 0,
  pickup_at INTEGER,
  returned_at INTEGER,
  settled_at INTEGER,
  rain_stopped_at INTEGER,
  charging_ack INTEGER NOT NULL DEFAULT 0,
  late_released_at INTEGER,
  note TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bookings_time ON bookings (start_ms, end_ms);
CREATE INDEX IF NOT EXISTS idx_bookings_court ON bookings (court_id);
CREATE INDEX IF NOT EXISTS idx_bookings_machine ON bookings (machine_id);
CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings (status);

CREATE TABLE IF NOT EXISTS booking_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id TEXT,
  type TEXT NOT NULL,
  detail TEXT,
  at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS incidents (
  id TEXT PRIMARY KEY,
  booking_id TEXT,
  kind TEXT NOT NULL,                           -- jam | battery_dead | scratch | rain
  detail TEXT,
  at INTEGER NOT NULL,
  resolved_at INTEGER
);

-- 押金扣款：manager 依据归还记录确认。idem_key 保证同一原因只扣一次。
CREATE TABLE IF NOT EXISTS deductions (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL,
  reason_code TEXT NOT NULL,                    -- balls_short | scratch | equipment_damage
  amount INTEGER NOT NULL,
  detail TEXT,
  status TEXT NOT NULL DEFAULT 'proposed',      -- proposed | confirmed | rejected
  proposed_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  manager TEXT,
  idem_key TEXT UNIQUE NOT NULL,
  payment_ref TEXT
);

CREATE TABLE IF NOT EXISTS equipment_photos (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                          -- machine | battery | basket
  equipment_id TEXT NOT NULL,
  path TEXT NOT NULL,
  label TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor TEXT,
  action TEXT NOT NULL,
  detail TEXT
);

CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const LOCKING_STATUSES = ['confirmed', 'issued', 'rain_stopped'];

function openDb(file) {
  let db;
  if (file === ':memory:') {
    db = new DatabaseSync(':memory:');
  } else {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    db = new DatabaseSync(file);
  }
  db.exec(SCHEMA);
  return db;
}

module.exports = { openDb, LOCKING_STATUSES };
