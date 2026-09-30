"""In-process background scheduler.

Periodically (default every 5s, accelerated in tests):
  * release reservations whose grace window expired without checkout;
  * mark fully-charged batteries as charged;
  * optionally auto stop/resume courts from the simulated weather adapter.
"""
from __future__ import annotations

import logging
import threading
from typing import Optional

from .service import ClubService

log = logging.getLogger("scheduler")


class Scheduler:
    def __init__(self, svc: ClubService, interval_sec: float = 5.0,
                 weather_watch: bool = True):
        self.svc = svc
        self.interval = interval_sec
        self.weather_watch = weather_watch
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self.ticks = 0
        self.events: list[dict] = []
        self._lock = threading.Lock()

    def tick(self) -> dict:
        """One maintenance pass — also callable directly from tests."""
        late = self.svc.release_late()
        charged = self.svc.complete_charges()
        rain_action = None
        if self.weather_watch and self.svc.weather is not None:
            playable = self.svc.weather.is_playable()
            active = self.svc.rain_status()["active"]
            if not playable and not active:
                out = self.svc.rain_suspend_all("天气适配器：阵雨预警自动停场")
                rain_action = {"type": "suspend", **out}
            elif playable and active:
                out = self.svc.rain_resume()
                rain_action = {"type": "resume", **out}
        summary = {"late_released": late, "charges_completed": charged,
                   "rain": rain_action}
        with self._lock:
            self.ticks += 1
            if late or charged or rain_action:
                self.events.append(summary)
        if late:
            log.info("迟到释放: %s", late)
        if charged:
            log.info("充电完成: %s", charged)
        if rain_action:
            log.info("天气动作: %s", rain_action)
        return summary

    def _run(self) -> None:
        while not self._stop.wait(self.interval):
            try:
                self.tick()
            except Exception:  # never let the loop die
                log.exception("scheduler tick failed")

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, daemon=True,
                                        name="club-scheduler")
        self._thread.start()

    def stop(self, timeout: float = 3.0) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout)
