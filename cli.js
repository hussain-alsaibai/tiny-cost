#!/usr/bin/env node
'use strict';

/**
 * Standalone CLI shim for tiny-budget.
 * Delegates to tiny_budget.js's main-branch CLI.
 */

// Re-implement the small CLI surface here to avoid the require.main === module trap.

const { DEFAULT_PRICING } = require('./tiny_budget.js');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);

function parseLimit(arg) {
  if (!arg) return null;
  const m = arg.match(/--limit-usd=([\d.]+)/);
  return m ? parseFloat(m[1]) : null;
}

if (args[0] === 'simulate') {
  const limitUsd = parseLimit(args.find(a => a.startsWith('--limit-usd=')));
  if (limitUsd === null) {
    console.error('simulate requires --limit-usd=<amount>');
    process.exit(2);
  }
  const { Budget } = require('./tiny_budget.js');
  const b = new Budget({ limitUsd });
  let line = 0;
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    const parts = buf.split('\n');
    buf = parts.pop();
    for (const ln of parts) {
      if (!ln.trim()) continue;
      line++;
      try {
        const rec = JSON.parse(ln);
        const r = b.charge(rec.model, rec.tokensIn || 0, rec.tokensOut || 0, rec.label || '');
        console.log(JSON.stringify({ ok: true, line, ...r }));
      } catch (err) {
        console.log(JSON.stringify({ ok: false, line, error: err.message }));
        if (err.name === 'BudgetExceeded') process.exit(1);
      }
    }
  });
  process.stdin.on('end', () => {
    if (buf.trim()) {
      line++;
      try {
        const rec = JSON.parse(buf);
        const r = b.charge(rec.model, rec.tokensIn || 0, rec.tokensOut || 0, rec.label || '');
        console.log(JSON.stringify({ ok: true, line, ...r }));
      } catch (err) {
        console.log(JSON.stringify({ ok: false, line, error: err.message }));
      }
    }
  });
} else if (args[0] === 'price') {
  const model = args[1];
  if (!model) {
    console.log(JSON.stringify(DEFAULT_PRICING, null, 2));
  } else {
    const p = DEFAULT_PRICING[model];
    if (!p) {
      console.error(`unknown model: ${model}`);
      process.exit(1);
    }
    console.log(JSON.stringify({ [model]: p }, null, 2));
  }
} else {
  console.log(`tiny-budget — AI cost/token budget enforcement
Usage:
  tiny-budget simulate --limit-usd=1.00 < charges.jsonl
  tiny-budget price [model]

Each line of charges.jsonl: {"model":"openai/gpt-4o-mini","tokensIn":120,"tokensOut":45,"label":"summary"}
`);
}