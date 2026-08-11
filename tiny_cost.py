"""
tiny-cost — Token Cost Tracking & Budget Enforcement for Python AI Agents
-----------------------------------------------------------------------
Track LLM spend across providers, enforce limits, circuit-break on overspend.
One file, zero deps, MIT.
"""
from __future__ import annotations
import threading, time, sys, json
from dataclasses import dataclass, field
from typing import Any, Optional, Callable

DEFAULT_PRICING = {
    "gpt-4o": {"input": 2.50, "output": 10.00}, "gpt-4o-mini": {"input": 0.15, "output": 0.60},
    "o1-preview": {"input": 15.00, "output": 60.00}, "o1-mini": {"input": 3.00, "output": 12.00},
    "claude-3-5-sonnet": {"input": 3.00, "output": 15.00}, "claude-3-5-haiku": {"input": 0.80, "output": 4.00},
    "gemini-2.5-flash": {"input": 0.075, "output": 0.30}, "gemini-2.5-pro": {"input": 1.25, "output": 5.00},
    "grok-2": {"input": 2.00, "output": 10.00}, "llama3": {"input": 0.00, "output": 0.00},
}

class BudgetExceeded(Exception):
    def __init__(self, msg, limit_type="total", limit_val=0.0, current_val=0.0, model=None):
        super().__init__(msg)
        self.limit_type, self.limit_value, self.current_value, self.model = limit_type, limit_val, current_val, model

class CircuitBroken(Exception): pass

@dataclass
class CostEntry:
    timestamp: float; model: str; input_tokens: int; output_tokens: int
    cost_usd: float; request_id: Optional[str] = None; metadata: dict = field(default_factory=dict)

class TokenBudget:
    def __init__(self, pricing=None, max_total=None, max_per_call=None, max_per_day=None,
                 raise_on_exceeded=True, on_exceeded: Optional[Callable]=None,
                 circuit_break_threshold=5, circuit_break_window_s=60.0):
        self._pricing = {**DEFAULT_PRICING, **(pricing or {})}
        self._max_total, self._max_per_call, self._max_per_day = max_total, max_per_call, max_per_day
        self._raise_on_exceeded, self._on_exceeded = raise_on_exceeded, on_exceeded
        self._lock = threading.RLock()
        self._entries, self._total, self._daily_total, self._per_call_count = [], 0.0, 0.0, 0
        self._daily_start = _day_start()
        self._circuit_errors, self._circuit_state = [], "closed"
        self._circuit_break_threshold, self._circuit_break_window_s = circuit_break_threshold, circuit_break_window_s

    def set_price(self, model, input_per_m, output_per_m):
        with self._lock: self._pricing[model] = {"input": input_per_m, "output": output_per_m}

    def estimate_cost(self, model, input_tokens, output_tokens):
        p = self._pricing.get(model, {"input": 0.0, "output": 0.0})
        return (input_tokens/1e6)*p["input"] + (output_tokens/1e6)*p["output"]

    def track(self, model, input_tokens, output_tokens, request_id=None, metadata=None, latency_s=0.0, error=False):
        self._maybe_reset_daily()
        cost = self.estimate_cost(model, input_tokens, output_tokens)
        entry = CostEntry(time.time(), model, input_tokens, output_tokens, cost, request_id, dict(metadata or {}))
        with self._lock:
            if self._circuit_state == "open": raise CircuitBroken()
            for limit_type, limit_val, current in [
                ("per_call", self._max_per_call, cost),
                ("total", self._max_total, self._total + cost),
                ("daily", self._max_per_day, self._daily_total + cost),
            ]:
                if limit_val is not None and current > limit_val:
                    msg = f"Budget exceeded: {limit_type} ${current:.4f} > ${limit_val:.4f}"
                    if self._on_exceeded: self._on_exceeded(limit_type, limit_val, current)
                    if self._raise_on_exceeded: raise BudgetExceeded(msg, limit_type, limit_val, current, model)
                    entry.metadata["budget_exceeded"] = True
            self._entries.append(entry); self._total += cost; self._daily_total += cost; self._per_call_count += 1
            if error:
                self._circuit_errors.append(time.time())
                self._prune_circuit_errors()
                if len(self._circuit_errors) >= self._circuit_break_threshold: self._circuit_state = "open"
        return entry

    def _prune_circuit_errors(self):
        cutoff = time.time() - self._circuit_break_window_s
        self._circuit_errors = [t for t in self._circuit_errors if t > cutoff]

    def circuit_state(self):
        with self._lock:
            if self._circuit_state == "open":
                self._prune_circuit_errors()
                if not self._circuit_errors: self._circuit_state = "half_open"
            return self._circuit_state

    def reset_circuit(self):
        with self._lock: self._circuit_state = "closed"; self._circuit_errors.clear()

    def _maybe_reset_daily(self):
        now = _day_start()
        with self._lock:
            if now > self._daily_start: self._daily_start = now; self._daily_total = 0.0

    @property def total_cost(self): with self._lock: return self._total
    @property def daily_cost(self): with self._lock: return self._daily_total
    @property def call_count(self): with self._lock: return self._per_call_count

    def stats(self, since=None):
        s = {"calls": 0, "total_input_tokens": 0, "total_output_tokens": 0, "total_cost_usd": 0.0, "errors": 0}
        with self._lock:
            for e in self._entries:
                if since and e.timestamp < since: continue
                s["total_input_tokens"] += e.input_tokens; s["total_output_tokens"] += e.output_tokens
                s["total_cost_usd"] += e.cost_usd; s["calls"] += 1
                s["errors"] += 1 if e.metadata.get("error") else 0
        return s

    def cost_by_model(self):
        r = {}
        with self._lock:
            for e in self._entries: r[e.model] = r.get(e.model, 0.0) + e.cost_usd
        return r

    def remaining(self):
        with self._lock:
            r = {}
            if self._max_total: r["total"] = round(max(0.0, self._max_total - self._total), 6)
            if self._max_per_day: r["daily"] = round(max(0.0, self._max_per_day - self._daily_total), 6)
            return r

    def can_afford(self, model, input_tokens, output_tokens):
        cost = self.estimate_cost(model, input_tokens, output_tokens)
        with self._lock:
            if self._max_total and (self._total + cost) > self._max_total: return False
            if self._max_per_call and cost > self._max_per_call: return False
            if self._max_per_day and (self._daily_total + cost) > self._max_per_day: return False
            return True

    def reset(self):
        with self._lock: self._entries.clear(); self._total = 0.0; self._daily_total = 0.0
        self._per_call_count = 0; self._circuit_state = "closed"; self._circuit_errors.clear()

def _day_start():
    import datetime
    today = datetime.datetime.now(datetime.timezone.utc).date()
    return datetime.datetime.combine(today, datetime.datetime.min.time(), tzinfo=datetime.timezone.utc).timestamp()

# Global singleton
_global: Optional[TokenBudget] = None
_glock = threading.Lock()

def configure(max_total=None, max_per_call=None, max_per_day=None, pricing=None,
              raise_on_exceeded=True, on_exceeded=None) -> TokenBudget:
    global _global
    with _glock:
        _global = TokenBudget(max_total=max_total, max_per_call=max_per_call, max_per_day=max_per_day,
                              pricing=pricing, raise_on_exceeded=raise_on_exceeded, on_exceeded=on_exceeded)
        return _global

def get_budget() -> Optional[TokenBudget]: return _global
