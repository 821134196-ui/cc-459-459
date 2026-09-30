'use strict';

// 进程内任务：迟到释放、电池充电完成、天气挂旗。setInterval 周期扫描。
class Scheduler {
  constructor(svc, intervalMs = 5000, opts = {}) {
    this.svc = svc;
    this.intervalMs = intervalMs;
    this.persistClock = opts.persistClock || null;
    this.timer = null;
    this.lastTick = null;
    this.history = [];
  }

  start() {
    if (this.timer) return;
    // 启动后先扫一次（迟到订单立即释放），之后周期性扫描
    this.runOnce();
    this.timer = setInterval(() => this.runOnce(), this.intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  runOnce() {
    let result;
    try {
      result = this.svc.tick();
      if (this.persistClock) this.persistClock(this.svc.t);
    } catch (e) {
      result = { error: e.message };
    }
    this.lastTick = { at: this.svc.t, result };
    const changed = (result.lateReleased && result.lateReleased.length)
      || (result.chargesCompleted && result.chargesCompleted.length)
      || (result.rainCourts && result.rainCourts.length)
      || (result.rainResumed && result.rainResumed.length);
    if (changed) this.history.unshift(this.lastTick);
    this.history = this.history.slice(0, 30);
    return result;
  }
}

module.exports = { Scheduler };
