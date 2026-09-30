'use strict';

// 时间与编号工具。系统内部一律用毫秒时间戳比较，库存 ISO 字符串便于阅读。

function pad(n) {
  return String(n).padStart(2, '0');
}

function fmtTime(ms) {
  if (ms == null) return '—';
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtDateTime(ms) {
  if (ms == null) return '—';
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function iso(ms) {
  return ms == null ? null : new Date(ms).toISOString();
}

function parseIso(s) {
  return s == null ? null : new Date(s).getTime();
}

function todayStr(now = Date.now()) {
  const d = new Date(now);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function dayStart(now = Date.now()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// 演示日历展示窗口 07:00–22:00
const CAL_OPEN_HOUR = 7;
const CAL_CLOSE_HOUR = 22;

function calWindow(now = Date.now()) {
  const base = dayStart(now);
  return { start: base + CAL_OPEN_HOUR * 3600e3, end: base + CAL_CLOSE_HOUR * 3600e3 };
}

function overlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && aEnd > bStart;
}

let counter = 0;
function uid(prefix) {
  counter = (counter + 1) % 1e6;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${process.pid.toString(36)}`;
}

function yuan(n) {
  return `¥${Number(n || 0).toFixed(0)}`;
}

module.exports = {
  pad,
  fmtTime,
  fmtDateTime,
  iso,
  parseIso,
  todayStr,
  dayStart,
  calWindow,
  CAL_OPEN_HOUR,
  CAL_CLOSE_HOUR,
  overlap,
  uid,
  yuan,
};
