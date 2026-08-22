"""
Tests for tiny-cost (Python).
Run: pytest test_tiny_cost.py -v
"""
import json, os, tempfile, pytest
from tiny_cost import TokenBudget, BudgetExceeded, CircuitBroken, DEFAULT_PRICING


class TestPricing:
    def test_default_pricing_loaded(self):
        tb = TokenBudget()
        assert "gpt-4o" in tb._pricing
        assert tb._pricing["gpt-4o"]["input"] == 2.50

    def test_estimate_gpt4o(self):
        tb = TokenBudget()
        # gpt-4o: input $2.50/1M, output $10.00/1M
        # 1M in, 500K out: $2.50 + $5.00 = $7.50
        cost = tb.estimate_cost("gpt-4o", 1_000_000, 500_000)
        assert abs(cost - 7.50) < 1e-9

    def test_estimate_unknown_model_free(self):
        tb = TokenBudget()
        cost = tb.estimate_cost("unknown-model", 1_000_000, 1_000_000)
        assert cost == 0.0

    def test_set_custom_price(self):
        tb = TokenBudget()
        tb.set_price("my-model", 1.0, 2.0)
        cost = tb.estimate_cost("my-model", 1_000_000, 0)
        assert cost == 1.0


class TestBudgetTracking:
    def test_track_basic(self):
        tb = TokenBudget()
        entry = tb.track("gpt-4o-mini", 1000, 500)
        assert entry.cost_usd > 0
        assert tb.total_cost == entry.cost_usd

    def test_total_limit_exceeded(self):
        tb = TokenBudget(max_total=0.001, raise_on_exceeded=True)
        with pytest.raises(BudgetExceeded) as exc_info:
            tb.track("gpt-4o", 1_000_000, 0)  # $2.50 — way over
        assert exc_info.value.limit_type == "total"

    def test_per_call_limit_exceeded(self):
        tb = TokenBudget(max_per_call=0.0001, raise_on_exceeded=True)
        with pytest.raises(BudgetExceeded) as exc_info:
            tb.track("gpt-4o", 1000, 500)
        assert exc_info.value.limit_type == "per_call"

    def test_no_raise_on_exceeded(self):
        tb = TokenBudget(max_total=0.0001, raise_on_exceeded=False)
        entry = tb.track("gpt-4o-mini", 1000, 500)
        assert entry.metadata.get("budget_exceeded") == True

    def test_on_exceeded_callback(self):
        events = []
        tb = TokenBudget(max_total=0.001, on_exceeded=lambda *a: events.append(a), raise_on_exceeded=True)
        # 100k tokens on gpt-4o-mini = ~$0.075; over 0.001 cap
        with pytest.raises(BudgetExceeded):
            tb.track("gpt-4o-mini", 50_000, 50_000)
        assert len(events) == 1

    def test_can_afford(self):
        tb = TokenBudget(max_total=0.01)
        assert tb.can_afford("gpt-4o-mini", 1000, 500)
        # Manually track a large cost by setting higher cap
        tb2 = TokenBudget(max_total=0.0001)
        # 100 tokens in + 50 out on gpt-4o-mini = ~$0.000015; tiny so won't trigger
        tb2.track("gpt-4o-mini", 100, 50)
        # Now simulate: check affordability
        assert tb2.can_afford("gpt-4o-mini", 100, 50)  # still within cap
        assert not tb2.can_afford("gpt-4o", 1_000_000, 0)  # $2.50 way over

    def test_remaining(self):
        tb = TokenBudget(max_total=0.01, max_per_day=0.005)
        tb.track("gpt-4o-mini", 1000, 500)
        r = tb.remaining()
        assert "total" in r
        assert "daily" in r
        assert r["total"] >= 0


class TestPersistence:
    def test_reset(self):
        tb = TokenBudget()
        tb.track("gpt-4o-mini", 1000, 500)
        assert tb.total_cost > 0
        tb.reset()
        assert tb.total_cost == 0.0
        assert tb.call_count == 0

    def test_stats(self):
        tb = TokenBudget()
        tb.track("gpt-4o", 1000, 500)
        tb.track("gpt-4o", 2000, 1000)
        s = tb.stats()
        assert s["calls"] == 2
        assert s["total_input_tokens"] == 3000
        assert s["total_output_tokens"] == 1500
        assert s["total_cost_usd"] > 0

    def test_cost_by_model(self):
        tb = TokenBudget()
        tb.track("gpt-4o", 1000, 500)
        tb.track("gpt-4o-mini", 1000, 500)
        by_model = tb.cost_by_model()
        assert "gpt-4o" in by_model
        assert "gpt-4o-mini" in by_model


class TestCircuitBreaker:
    def test_circuit_stays_closed_under_threshold(self):
        tb = TokenBudget(circuit_break_threshold=5)
        for _ in range(4):
            tb.track("gpt-4o", 100, 50, error=True)
        assert tb.circuit_state() == "closed"

    def test_circuit_opens_at_threshold(self):
        tb = TokenBudget(circuit_break_threshold=3)
        for _ in range(3):
            tb.track("gpt-4o", 100, 50, error=True)
        assert tb.circuit_state() == "open"

    def test_circuit_rejects_calls_when_open(self):
        tb = TokenBudget(circuit_break_threshold=2)
        tb.track("gpt-4o", 100, 50, error=True)
        tb.track("gpt-4o", 100, 50, error=True)
        with pytest.raises(CircuitBroken):
            tb.track("gpt-4o", 100, 50)

    def test_reset_circuit(self):
        tb = TokenBudget(circuit_break_threshold=2)
        tb.track("gpt-4o", 100, 50, error=True)
        tb.track("gpt-4o", 100, 50, error=True)
        assert tb.circuit_state() == "open"
        tb.reset_circuit()
        assert tb.circuit_state() == "closed"
