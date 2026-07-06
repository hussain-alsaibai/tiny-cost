'use strict';

/**
 * Tests for tiny-budget.
 * Run with: node test_tiny_budget.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const { Budget, BudgetExceeded, withBudget, DEFAULT_PRICING } = require('./tiny_budget');

let pass = 0;
let fail = 0;

function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { pass++; console.log(`  ok  ${name}`); },
    (err) => {
      fail++;
      console.error(`  FAIL ${name}`);
      console.error(err && err.stack || err);
    }
  );
}

(async () => {
  console.log('tiny-budget tests');

  await test('charge uses pricing table', () => {
    const b = new Budget();
    const r = b.charge('openai/gpt-4o-mini', 1000, 500, 'test');
    assert.strictEqual(r.usd, 0.00015 + 0.0003);
    assert.strictEqual(b.spentUsd, r.usd);
    assert.strictEqual(b.spentTokens, 1500);
  });

  await test('limitUsd enforced', () => {
    const b = new Budget({ limitUsd: 0.001 });
    b.charge('openai/gpt-4o-mini', 100, 0);  // $0.000015
    let threw = false;
    try {
      b.charge('openai/gpt-4o-mini', 100000, 0, 'huge');  // $0.015
    } catch (err) {
      threw = err.name === 'BudgetExceeded';
      assert.ok(err.record, 'record attached');
    }
    assert.ok(threw, 'should have thrown BudgetExceeded');
  });

  await test('limitTokens enforced', () => {
    const b = new Budget({ limitTokens: 1000 });
    b.charge('openai/gpt-4o-mini', 500, 200);
    let threw = false;
    try {
      b.charge('openai/gpt-4o-mini', 200, 200);
    } catch (err) {
      threw = err.name === 'BudgetExceeded';
    }
    assert.ok(threw);
  });

  await test('persist and reload survives crash', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tiny-budget-'));
    const file = path.join(dir, 'budget.json');
    const b1 = new Budget({ path: file, limitUsd: 1.00, taskId: 'task-xyz' });
    b1.charge('openai/gpt-4o-mini', 1000, 500, 'first');
    b1.charge('openai/gpt-4o-mini', 200, 100, 'second');
    // Simulate process restart: new Budget, same task id
    const b2 = new Budget({ path: file, limitUsd: 1.00, taskId: 'task-xyz' });
    assert.strictEqual(b2.spentUsd, b1.spentUsd);
    assert.strictEqual(b2.spentTokens, b1.spentTokens);
    assert.strictEqual(b2.history.length, 2);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('different taskId starts fresh', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tiny-budget-'));
    const file = path.join(dir, 'budget.json');
    const b1 = new Budget({ path: file, limitUsd: 1.00, taskId: 'task-a' });
    b1.charge('openai/gpt-4o-mini', 5000, 1000);
    const b2 = new Budget({ path: file, limitUsd: 1.00, taskId: 'task-b' });
    assert.strictEqual(b2.spentUsd, 0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('chargeUsage accepts openai-style usage', () => {
    const b = new Budget();
    b.chargeUsage('openai/gpt-4o-mini', { prompt_tokens: 100, completion_tokens: 50 });
    assert.strictEqual(b.spentTokens, 150);
    assert.ok(b.spentUsd > 0);
  });

  await test('chargeUsage accepts anthropic-style usage', () => {
    const b = new Budget();
    b.chargeUsage('anthropic/claude-haiku-4', { input_tokens: 100, output_tokens: 50 });
    assert.strictEqual(b.spentTokens, 150);
  });

  await test('onWarn fires once at threshold', () => {
    let warnings = 0;
    const b = new Budget({
      limitUsd: 0.01,
      warnAt: 0.5,
      onWarn: () => { warnings++; },
    });
    b.charge('openai/gpt-4o-mini', 100, 0);   // $0.000015 (0.15%)
    b.charge('openai/gpt-4o-mini', 50000, 0); // $0.0075 (75%) → warn
    b.charge('openai/gpt-4o-mini', 1000, 0);  // 84% → no new warn
    assert.strictEqual(warnings, 1);
  });

  await test('onCharge fires for each charge', () => {
    let count = 0;
    const b = new Budget({ onCharge: () => { count++; } });
    b.charge('openai/gpt-4o-mini', 10, 5);
    b.charge('openai/gpt-4o-mini', 10, 5);
    b.charge('openai/gpt-4o-mini', 10, 5);
    assert.strictEqual(count, 3);
  });

  await test('unknown model throws', () => {
    const b = new Budget();
    let threw = false;
    try { b.charge('some/unknown-model', 100, 50); } catch (_) { threw = true; }
    assert.ok(threw);
  });

  await test('setPricing registers custom model', () => {
    const b = new Budget();
    b.setPricing('custom/my-llm', 0.001, 0.002);
    const r = b.charge('custom/my-llm', 1000, 500);
    assert.strictEqual(r.usd, 0.002);
  });

  await test('chargeFlat records manual spend', () => {
    const b = new Budget({ limitUsd: 1.00 });
    b.chargeFlat(0.5, 'half dollar API call');
    assert.strictEqual(b.spentUsd, 0.5);
  });

  await test('snapshot returns summary', () => {
    const b = new Budget({ limitUsd: 1.00, limitTokens: 1000, taskId: 'snap' });
    b.charge('openai/gpt-4o-mini', 100, 50);
    const s = b.snapshot();
    assert.strictEqual(s.taskId, 'snap');
    assert.strictEqual(s.limitUsd, 1.00);
    assert.ok(s.spentUsd > 0);
    assert.ok(s.remainingUsd < 1.00);
  });

  await test('reset clears spent counters', () => {
    const b = new Budget({ limitUsd: 1.00 });
    b.charge('openai/gpt-4o-mini', 1000, 500);
    b.reset('new-task');
    assert.strictEqual(b.spentUsd, 0);
    assert.strictEqual(b.spentTokens, 0);
    assert.strictEqual(b.taskId, 'new-task');
  });

  await test('withBudget wraps async fn', async () => {
    const b = new Budget({ limitUsd: 1.00 });
    const fn = withBudget(b, async (x) => x * 2);
    assert.strictEqual(await fn(21), 42);
  });

  await test('default pricing table has common providers', () => {
    assert.ok(DEFAULT_PRICING['openai/gpt-4o-mini']);
    assert.ok(DEFAULT_PRICING['anthropic/claude-sonnet-4']);
    assert.ok(DEFAULT_PRICING['google/gemini-2.5-flash']);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();