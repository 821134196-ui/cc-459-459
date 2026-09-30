"""Simulated outbound adapters: weather + payment.

Both are deterministic/local — no network. Weather can be forced via the
TEST_RAIN / weather state so seed data and demos can trigger a rain stop.
"""
from __future__ import annotations

import threading
from typing import Optional


class WeatherAdapter:
    """Returns a fake forecast. Mode: 'sunny' | 'cloudy' | 'rain'."""

    def __init__(self, mode: str = "sunny"):
        self._mode = mode
        self._lock = threading.Lock()

    def set_mode(self, mode: str) -> None:
        with self._lock:
            self._mode = mode

    def forecast(self) -> dict:
        with self._lock:
            mode = self._mode
        table = {
            "sunny":  {"condition": "晴",   "temp_c": 28, "precip_pct": 5,
                       "playable": True},
            "cloudy": {"condition": "多云", "temp_c": 25, "precip_pct": 30,
                       "playable": True},
            "rain":   {"condition": "阵雨", "temp_c": 22, "precip_pct": 90,
                       "playable": False},
        }
        out = dict(table[mode])
        out["mode"] = mode
        return out

    def is_playable(self) -> bool:
        return self.forecast()["playable"]


class PaymentGateway:
    """Mock payment/refund with idempotency keys (simulated PSP behavior)."""

    def __init__(self):
        self._seen: dict[str, str] = {}
        self._lock = threading.Lock()
        self._seq = 0

    def _id(self, kind: str) -> str:
        self._seq += 1
        return f"{kind.upper()}-{100000 + self._seq}"

    def _do(self, op: str, order_code: str, amount_fen: int,
            idem_key: Optional[str]) -> dict:
        if idem_key and idem_key in self._seen:
            return {"txn": self._seen[idem_key], "amount": amount_fen,
                    "order": order_code, "op": op, "idempotent_replay": True,
                    "status": "ok"}
        txn = self._id(op)
        if idem_key:
            self._seen[idem_key] = txn
        return {"txn": txn, "amount": amount_fen, "order": order_code,
                "op": op, "idempotent_replay": False, "status": "ok"}

    def capture(self, order_code: str, amount_fen: int,
                idem_key: Optional[str] = None) -> dict:
        return self._do("cap", order_code, amount_fen, idem_key)

    def refund(self, order_code: str, amount_fen: int,
               idem_key: Optional[str] = None) -> dict:
        return self._do("ref", order_code, amount_fen, idem_key)
