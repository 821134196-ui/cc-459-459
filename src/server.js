'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { openDb } = require('./db');
const { ClubService, DomainError, WeatherAdapter, PaymentAdapter } = require('./service');
const { Scheduler } = require('./scheduler');
const { seed } = require('./seed');
const { dayStart, todayStr } = require('./util');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, 'club.db');
const PHOTO_DIR = path.join(DATA_DIR, 'photos');
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 3000);

function createApp(opts = {}) {
  const dbFile = opts.dbFile || DB_FILE;
  const photoDir = opts.photoDir || PHOTO_DIR;
  let db, svc, scheduler;

  if (opts.seed) {
    const seeded = seed(dbFile, photoDir, { reset: opts.reset });
    db = seeded.db;
    svc = seeded.svc;
  } else {
    db = openDb(dbFile);
    // 从 SQLite 恢复播种时保存的演示时钟锚点与天气脚本，重启后时间轴连续
    const meta = Object.fromEntries(
      db.prepare(`SELECT key, value FROM app_meta`).all().map((r) => [r.key, r.value])
    );
    let nowFn;
    const weather = new WeatherAdapter();
    if (meta.demo_clock_demo && meta.demo_clock_real) {
      // 优先用调度器最近一次落盘的时刻对（同一进程内采集，换算自洽）；
      // 首次启动则回退到播种锚点。虚拟机墙上时钟可能跨进程回拨，故不依赖原始锚点换算。
      const demo = Number(meta.demo_clock_now || meta.demo_clock_demo);
      const real = Number(meta.demo_clock_real_at || meta.demo_clock_real);
      const bootReal = Date.now();
      const bootDemo = Math.max(demo, demo + (bootReal - real));
      nowFn = () => bootDemo + (Date.now() - bootReal);
      if (meta.weather_script) weather.setScript(JSON.parse(meta.weather_script));
    }
    svc = new ClubService(db, { photoDir, weather, ...(nowFn ? { now: nowFn } : {}) });
    // 雨窗相对本次启动时刻重新计时，保证重启后仍可演示雨停
    weather.setBase(svc.t);
  }
  // 每个调度周期把演示时钟落盘，供重启后恢复（upsert）
  const persistClock = (demoMs) => {
    db.prepare(
      `INSERT INTO app_meta (key,value) VALUES ('demo_clock_now',?),('demo_clock_real_at',?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`
    ).run(String(demoMs), String(Date.now()));
  };
  if (opts.scheduler !== false) {
    scheduler = new Scheduler(svc, opts.tickMs || 5000, { persistClock: db ? persistClock : null });
    scheduler.start();
  }

  function statePayload() {
    const day = dayStart(svc.t);
    return {
      now: svc.t,
      today: todayStr(svc.t),
      weather: svc.weather.getWeather(svc.t),
      availability: svc.availability(),
      members: svc.members(),
      modes: svc.modes(),
      bookings: svc.bookingsForDay(day),
      deductions: svc.deductions(),
      repairs: svc.repairs(),
      incidents: svc.incidents().slice(0, 30),
      scheduler: scheduler ? {
        lastTick: scheduler.lastTick,
        intervalMs: scheduler.intervalMs,
        history: scheduler.history.slice(0, 8),
      } : null,
      constants: require('./service').constants,
    };
  }

  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > 8 * 1024 * 1024) throw new DomainError('too_large', '请求体过大');
      chunks.push(c);
    }
    return Buffer.concat(chunks);
  }

  async function readJson(req) {
    const buf = await readBody(req);
    if (!buf.length) return {};
    try { return JSON.parse(buf.toString('utf8')); }
    catch { throw new DomainError('bad_json', '请求体不是合法 JSON'); }
  }

  function send(res, code, obj, headers = {}) {
    const body = typeof obj === 'string' || Buffer.isBuffer(obj) ? obj : JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
    res.end(body);
  }

  const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.json': 'application/json',
  };

  function serveStatic(res, urlPath) {
    const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR)) { send(res, 403, { error: 'forbidden' }); return; }
    fs.readFile(file, (err, data) => {
      if (err) { send(res, 404, { error: 'not_found' }); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
      res.end(data);
    });
  }

  function servePhoto(res, filename) {
    const file = path.normalize(path.join(photoDir, path.basename(filename)));
    if (!file.startsWith(photoDir)) { send(res, 403, { error: 'forbidden' }); return; }
    fs.readFile(file, (err, data) => {
      if (err) { send(res, 404, { error: 'not_found' }); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
      res.end(data);
    });
  }

  // 把领域错误映射为 HTTP 状态
  const CONFLICT_CODES = new Set([
    'court_conflict', 'machine_conflict', 'machine_maintenance', 'battery_not_ready',
    'battery_low', 'basket_busy', 'rain_suspended', 'deposit_low', 'bad_status',
    'expired', 'deduction_pending', 'battery_not_charging', 'not_counted',
    'payment_failed', 'already_rejected', 'no_return_record', 'forbidden',
  ]);

  async function handleApi(req, res, url) {
    const p = url.pathname;
    const method = req.method;
    const ok = (data) => send(res, 200, { ok: true, data });

    try {
      if (method === 'GET' && p === '/api/state') return ok(statePayload());
      if (method === 'POST' && p === '/api/tick') {
        const r = scheduler ? scheduler.runOnce() : svc.tick();
        return ok(r);
      }

      let m;
      if (method === 'POST' && p === '/api/bookings') {
        const body = await readJson(req);
        return ok(svc.createBooking({
          memberId: body.memberId, courtId: body.courtId, machineId: body.machineId,
          modeId: body.modeId || null,
          startMs: Number(body.startMs), endMs: Number(body.endMs), note: body.note,
        }));
      }
      if ((m = p.match(/^\/api\/bookings\/([^/]+)$/)) && method === 'GET') {
        return ok(svc.bookingDetail(m[1]));
      }
      if ((m = p.match(/^\/api\/bookings\/([^/]+)\/cancel$/)) && method === 'POST') {
        const { actor } = await readJson(req);
        return ok(svc.cancelBooking(m[1], actor || 'staff'));
      }
      if ((m = p.match(/^\/api\/bookings\/([^/]+)\/extend$/)) && method === 'POST') {
        const { minutes } = await readJson(req);
        return ok(svc.extendBooking(m[1], Number(minutes)));
      }
      if ((m = p.match(/^\/api\/bookings\/([^/]+)\/pickup$/)) && method === 'POST') {
        const body = await readJson(req);
        return ok(svc.pickup(m[1], {
          batteryId: body.batteryId || null, basketId: body.basketId || null,
          balls: body.balls != null ? Number(body.balls) : undefined,
        }));
      }
      if ((m = p.match(/^\/api\/bookings\/([^/]+)\/return$/)) && method === 'POST') {
        const body = await readJson(req);
        return ok(svc.returnEquipment(m[1], {
          ballsReturned: Number(body.ballsReturned),
          rain: !!body.rain, scratch: !!body.scratch,
          scratchNote: body.scratchNote || null,
          batteryPct: body.batteryPct != null ? Number(body.batteryPct) : undefined,
        }));
      }
      if ((m = p.match(/^\/api\/bookings\/([^/]+)\/settle$/)) && method === 'POST') {
        return ok(svc.settle(m[1]));
      }
      if ((m = p.match(/^\/api\/bookings\/([^/]+)\/jam$/)) && method === 'POST') {
        const body = await readJson(req);
        return ok(svc.reportJam(m[1], !!body.resolved, body.note || '卡球'));
      }
      if ((m = p.match(/^\/api\/bookings\/([^/]+)\/swap-battery$/)) && method === 'POST') {
        const body = await readJson(req);
        return ok(svc.swapBattery(m[1], body.batteryId || null));
      }

      if (method === 'GET' && p === '/api/deductions') return ok(svc.deductions());
      if (method === 'POST' && p === '/api/deductions') {
        const body = await readJson(req);
        return ok(svc.proposeDeduction(body.bookingId, body.reasonCode, Number(body.amount), body.detail));
      }
      if ((m = p.match(/^\/api\/deductions\/([^/]+)\/confirm$/)) && method === 'POST') {
        const { manager, role } = await readJson(req);
        // 押金扣款只允许经理：必须显式以经理身份登录（role=manager 且署名）
        if (role !== 'manager' || !manager) {
          throw new DomainError('forbidden', '只有经理可以依据归还记录确认押金扣款');
        }
        return ok(svc.confirmDeduction(m[1], manager));
      }
      if ((m = p.match(/^\/api\/deductions\/([^/]+)\/reject$/)) && method === 'POST') {
        const { manager, role } = await readJson(req);
        if (role !== 'manager' || !manager) {
          throw new DomainError('forbidden', '只有经理可以驳回扣款');
        }
        return ok(svc.rejectDeduction(m[1], manager));
      }

      if (method === 'GET' && p === '/api/repairs') return ok(svc.repairs());
      if (method === 'GET' && p === '/api/incidents') return ok(svc.incidents());
      if ((m = p.match(/^\/api\/machines\/([^/]+)\/repair$/)) && method === 'POST') {
        const body = await readJson(req);
        return ok(svc.reportRepair(m[1], {
          reason: body.reason, reporter: body.reporter || 'staff',
          bookingId: body.bookingId || null, fee: Number(body.fee || 0),
        }));
      }
      if ((m = p.match(/^\/api\/repairs\/([^/]+)\/resolve$/)) && method === 'POST') {
        const { manager } = await readJson(req);
        return ok(svc.resolveRepair(m[1], manager || 'manager'));
      }
      if ((m = p.match(/^\/api\/courts\/([^/]+)\/rain$/)) && method === 'POST') {
        const { suspended } = await readJson(req);
        return ok(svc.setCourtRain(m[1], !!suspended, 'staff'));
      }

      // 照片：本地目录保存。PUT/POST 原始字节，文件名由服务端生成
      if (method === 'POST' && p === '/api/photos') {
        const kind = url.searchParams.get('kind');
        const equipmentId = url.searchParams.get('id');
        const label = url.searchParams.get('label') || '';
        if (!['machine', 'battery', 'basket'].includes(kind) || !equipmentId) {
          throw new DomainError('bad_input', '缺少 kind 或设备 id');
        }
        const buf = await readBody(req);
        if (!buf.length) throw new DomainError('bad_input', '照片内容为空');
        fs.mkdirSync(photoDir, { recursive: true });
        const ext = (req.headers['content-type'] || '').includes('png') ? 'png'
          : (req.headers['content-type'] || '').includes('jpeg') ? 'jpg' : 'svg';
        const filename = `${kind}_${equipmentId}_${crypto.randomBytes(4).toString('hex')}.${ext}`;
        fs.writeFileSync(path.join(photoDir, filename), buf);
        return ok(svc.addPhoto(kind, equipmentId, filename, label));
      }
      if ((m = p.match(/^\/api\/photos\/([^/]+)\/([^/]+)$/)) && method === 'GET') {
        return ok(svc.photos(m[1], m[2]));
      }

      send(res, 404, { error: 'not_found', path: p });
    } catch (e) {
      if (e instanceof DomainError) {
        return send(res, CONFLICT_CODES.has(e.code) ? 409 : 400, { error: e.code, message: e.message, info: { ...e } });
      }
      send(res, 500, { error: 'server_error', message: e.message });
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
    if (url.pathname.startsWith('/photos/')) return servePhoto(res, url.pathname.slice('/photos/'.length));
    if (url.pathname === '/favicon.ico') {
      res.writeHead(204);
      return res.end();
    }
    return serveStatic(res, url.pathname);
  });

  return {
    server, svc, db, scheduler,
    start(port = PORT) {
      return new Promise((resolve) => {
        server.listen(port, () => {
          console.log(`🎾 网球俱乐部系统已启动: http://localhost:${port}`);
          console.log(`   数据库: ${dbFile}`);
          console.log(`   设备照片: ${photoDir}`);
          console.log(`   演示样例: 迟到释放 LATE03 / 球数短缺 SHORT4 / 雨停 RAIN05 / 维修 PM-103 / 充电 BAT-B`);
          resolve(server);
        });
      });
    },
  };
}

module.exports = { createApp };

if (require.main === module) {
  const reset = process.env.RESEED === '1' || !fs.existsSync(DB_FILE);
  const app = createApp({ seed: true, reset });
  app.start();
}
