"""
Benchmark: tiny-cost TokenBudget tracking overhead.
Run: python3 bench_tiny_cost.py
"""
import time
from tiny_cost import TokenBudget

def bench_track(n=100_000):
    tb = TokenBudget()
    start = time.perf_counter()
    for i in range(n):
        tb.track("gpt-4o-mini", 1000, 500)
    elapsed = time.perf_counter() - start
    print(f"  {n:,} track() calls: {elapsed:.3f}s ({n/elapsed:,.0f}/sec)")
    print(f"  Per-call overhead: {elapsed/n*1e6:.3f} µs")

def bench_estimate(n=1_000_000):
    tb = TokenBudget()
    start = time.perf_counter()
    for i in range(n):
        tb.estimate_cost("gpt-4o", 1000, 500)
    elapsed = time.perf_counter() - start
    print(f"  {n:,} estimate_cost() calls: {elapsed:.3f}s ({n/elapsed:,.0f}/sec)")

def bench_can_afford(n=100_000):
    tb = TokenBudget(max_total=1.0)
    start = time.perf_counter()
    for i in range(n):
        tb.can_afford("gpt-4o", 500, 250)
    elapsed = time.perf_counter() - start
    print(f"  {n:,} can_afford() calls: {elapsed:.3f}s ({n/elapsed:,.0f}/sec)")

def bench_stats(n=10_000):
    tb = TokenBudget()
    for _ in range(n):
        tb.track("gpt-4o", 100, 50)
    start = time.perf_counter()
    for _ in range(100):
        s = tb.stats()
        by = tb.cost_by_model()
    elapsed = time.perf_counter() - start
    print(f"  stats() x100 over {n:,} entries: {elapsed:.3f}s")

if __name__ == "__main__":
    print("=== tiny-cost benchmarks ===")
    bench_track()
    bench_estimate()
    bench_can_afford()
    bench_stats()
