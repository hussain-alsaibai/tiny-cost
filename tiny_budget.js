'use strict';

/**
 * tiny-budget — zero-dep runtime budget enforcement for AI agents.
 *
 * Tracks USD and token spend against per-task limits, throws BudgetExceeded
 * when limits are crossed, and persists state to a local JSON file so a
 * crashed agent doesn't double-spend on its next run.
 *
 * Designed for the OpenClaw workflow: many short-lived agent tasks that need
 * a hard cap on cost so a runaway loop doesn't burn $200 of LLM tokens.
 *
 * NOT a payment processor. NOT an OpenAI wrapper. Just a small ledger.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------- Pricing ----------
// Default USD per 1K tokens for common providers (input, output).
// Override with setPricing() or constructor option.
const DEFAULT_PRICING = {
  'openai/gpt-4o':           { input: 0.005,  output: 0.015 },
  'openai/gpt-4o-mini':      { input: 0.00015, output: 0.0006 },
  'openai/gpt-4.1':          { input: 0.010,  output: 0.030 },
  'openai/gpt-4.1-mini':     { input: 0.0004,  output: 0.0016 },
  'openai/o3':               { input: 0.010,  output: 0.040 },
  'openai/o4-mini':          { input: 0.0011, output: 0.0044 },
  'anthropic/claude-opus-4': { input: 0.015,  output: 0.075 },
  'anthropic/claude-sonnet-4':{ input: 0.003,  output: 0.015 },
  'anthropic/claude-haiku-4': { input: 0.0008, output: 0.004 },
  'google/gemini-2.5-pro':   { input: 0.00125, output: 0.01 },
  'google/gemini-2.5-flash': { input: 0.000075, output: 0.0003 },
};

class BudgetExceeded extends Error {
  constructor(message, record) {
    super(message);
    this.name = 'BudgetExceeded';
    this.record = record; // { taskId, spentUsd, limitUsd, spentTokens, ... }
  }
}

class Budget {
  /**
   * @param {object} opts
   * @param {string} [opts.path]            Path to JSON persistence file.
   * @param {string} [opts.taskId]          Default task id (otherwise auto-uuid).
   * @param {number} [opts.limitUsd]        Hard USD cap for this task.
   * @param {number} [opts.limitTokens]     Optional token cap.
   * @param {number} [opts.warnAt]          Warn when this fraction of limit is crossed (0..1).
   * @param {object} [opts.pricing]         Override pricing table.
   * @param {boolean} [opts.autosave=true]  Persist after every charge().
   * @param {(rec: object) => void} [opts.onWarn]
   * @param {(rec: object) => void} [opts.onCharge]
   */
  constructor(opts = {}) {
    this.path = opts.path || null;
    this.taskId = opts.taskId || crypto.randomUUID();
    this.limitUsd = opts.limitUsd ?? Infinity;
    this.limitTokens = opts.limitTokens ?? Infinity;
    this.warnAt = opts.warnAt ?? 0.8;
    this.pricing = { ...DEFAULT_PRICING, ...(opts.pricing || {}) };
    this.autosave = opts.autosave !== false;
    this.onWarn = opts.onWarn || null;
    this.onCharge = opts.onCharge || null;
    this.spentUsd = 0;
    this.spentTokens = 0;
    this.warnedAt = 0; // fraction we already warned at; default 0 means fire when first crossing warnAt
    this.history = []; // [{ts, model, tokensIn, tokensOut, usd, label}]
    this._load();
  }

  // ---------- Persistence ----------

  _load() {
    if (!this.path) return;
    try {
      const raw = fs.readFileSync(this.path, 'utf8');
      const data = JSON.parse(raw);
      // Only restore if the saved task id matches (otherwise it's a different task)
      if (data.taskId === this.taskId) {
        this.spentUsd = data.spentUsd || 0;
        this.spentTokens = data.spentTokens || 0;
        this.history = data.history || [];
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  _persist() {
    if (!this.path || !this.autosave) return;
    const dir = path.dirname(this.path);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = this.path + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({
      taskId: this.taskId,
      spentUsd: this.spentUsd,
      spentTokens: this.spentTokens,
      history: this.history,
      savedAt: new Date().toISOString(),
    }, null, 2));
    fs.renameSync(tmp, this.path); // atomic on POSIX
  }

  // ---------- Charging ----------

  /**
   * Charge the budget for a model call.
   * @param {string} model            e.g. "openai/gpt-4o-mini"
   * @param {number} tokensIn
   * @param {number} tokensOut
   * @param {string} [label]          Free-form description for history.
   * @returns {object}                The charge record.
   */
  charge(model, tokensIn, tokensOut, label = '') {
    const usd = this._computeUsd(model, tokensIn, tokensOut);
    const tokens = tokensIn + tokensOut;
    const newUsd = this.spentUsd + usd;
    const newTokens = this.spentTokens + tokens;

    const record = {
      ts: new Date().toISOString(),
      taskId: this.taskId,
      model,
      tokensIn,
      tokensOut,
      usd,
      label,
      spentUsd: newUsd,
      spentTokens: newTokens,
    };

    if (newUsd > this.limitUsd) {
      throw new BudgetExceeded(
        `Budget exceeded: $${newUsd.toFixed(4)} > $${this.limitUsd.toFixed(4)} ` +
        `after charging $${usd.toFixed(4)} for ${model}`,
        record
      );
    }
    if (newTokens > this.limitTokens) {
      throw new BudgetExceeded(
        `Token budget exceeded: ${newTokens} > ${this.limitTokens} tokens`,
        record
      );
    }

    this.spentUsd = newUsd;
    this.spentTokens = newTokens;
    this.history.push({ ts: record.ts, model, tokensIn, tokensOut, usd, label });

    // Warning threshold (fire only when crossing into a new band >= warnAt)
    const fracUsd = this.limitUsd === Infinity ? 0 : this.spentUsd / this.limitUsd;
    const fracTokens = this.limitTokens === Infinity ? 0 : this.spentTokens / this.limitTokens;
    const frac = Math.max(fracUsd, fracTokens);
    if (frac >= this.warnAt && this.warnedAt < this.warnAt) {
      this.warnedAt = frac;
      if (this.onWarn) {
        try { this.onWarn(record); } catch (_) { /* don't let onWarn kill the call */ }
      }
    }

    this._persist();
    if (this.onCharge) {
      try { this.onCharge(record); } catch (_) {}
    }
    return record;
  }

  /**
   * Convenience: charge based on a usage object that looks like an OpenAI/Anthropic response.
   * Accepts either {prompt_tokens, completion_tokens} or {input_tokens, output_tokens}.
   */
  chargeUsage(model, usage, label = '') {
    const tokensIn = usage.prompt_tokens ?? usage.input_tokens ?? 0;
    const tokensOut = usage.completion_tokens ?? usage.output_tokens ?? 0;
    return this.charge(model, tokensIn, tokensOut, label);
  }

  /**
   * Manually record a spend (for cases where pricing is opaque, e.g. a fixed-cost API).
   * Bypasses the pricing table; tokens are not counted.
   */
  chargeFlat(usd, label = '') {
    const newUsd = this.spentUsd + usd;
    if (newUsd > this.limitUsd) {
      throw new BudgetExceeded(
        `Budget exceeded: $${newUsd.toFixed(4)} > $${this.limitUsd.toFixed(4)} ` +
        `after flat charge $${usd.toFixed(4)}`,
        { taskId: this.taskId, usd, spentUsd: newUsd, label }
      );
    }
    this.spentUsd = newUsd;
    const record = { ts: new Date().toISOString(), taskId: this.taskId, model: 'flat', tokensIn: 0, tokensOut: 0, usd, label, spentUsd: newUsd, spentTokens: this.spentTokens };
    this.history.push({ ts: record.ts, model: 'flat', tokensIn: 0, tokensOut: 0, usd, label });
    this._persist();
    if (this.onCharge) {
      try { this.onCharge(record); } catch (_) {}
    }
    return record;
  }

  // ---------- Inspection ----------

  remainingUsd() {
    return this.limitUsd === Infinity ? Infinity : Math.max(0, this.limitUsd - this.spentUsd);
  }

  remainingTokens() {
    return this.limitTokens === Infinity ? Infinity : Math.max(0, this.limitTokens - this.spentTokens);
  }

  snapshot() {
    return {
      taskId: this.taskId,
      spentUsd: this.spentUsd,
      spentTokens: this.spentTokens,
      limitUsd: this.limitUsd,
      limitTokens: this.limitTokens,
      remainingUsd: this.remainingUsd(),
      remainingTokens: this.remainingTokens(),
      charges: this.history.length,
    };
  }

  reset(newTaskId = crypto.randomUUID()) {
    this.taskId = newTaskId;
    this.spentUsd = 0;
    this.spentTokens = 0;
    this.history = [];
    this.warnedAt = 0;
    this._persist();
  }

  // ---------- Pricing ----------

  setPricing(model, inputPer1k, outputPer1k) {
    this.pricing[model] = { input: inputPer1k, output: outputPer1k };
  }

  _computeUsd(model, tokensIn, tokensOut) {
    const p = this.pricing[model];
    if (!p) {
      // Unknown model: refuse to silently undercharge. Caller can register
      // pricing or use chargeFlat().
      throw new Error(
        `Unknown model "${model}". Register pricing via setPricing() or use chargeFlat().`
      );
    }
    return (tokensIn / 1000) * p.input + (tokensOut / 1000) * p.output;
  }
}

// ---------- Helpers ----------

/**
 * Wrap an LLM-calling async function so every call goes through Budget.charge().
 * If the call throws BudgetExceeded, BudgetExceeded is re-thrown after cleanup.
 *
 *   const ask = withBudget(budget, async (model, messages) => {
 *     const r = await openai.chat.completions.create({ model, messages });
 *     budget.chargeUsage(model, r.usage);
 *     return r.choices[0].message;
 *   });
 */
function withBudget(budget, fn) {
  return async function budgeted(...args) {
    try {
      return await fn(...args);
    } catch (err) {
      if (err.name === 'BudgetExceeded') {
        // Caller is responsible for actually having charged before the call.
        // We just propagate.
        throw err;
      }
      throw err;
    }
  };
}

module.exports = { Budget, BudgetExceeded, withBudget, DEFAULT_PRICING };

// CLI: print budget summary or simulate charges from JSONL on stdin
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args[0] === 'simulate') {
    // tiny-budget simulate --limit-usd=0.50
    const limitUsd = parseFloat((args.find(a => a.startsWith('--limit-usd=')) || '').split('=')[1] || '1.00');
    const b = new Budget({ limitUsd });
    let line = 0;
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      for (const ln of chunk.split('\n')) {
        if (!ln.trim()) continue;
        try {
          const rec = JSON.parse(ln);
          const r = b.charge(rec.model, rec.tokensIn || 0, rec.tokensOut || 0, rec.label || '');
          console.log(JSON.stringify({ ok: true, line: ++line, ...r }));
        } catch (err) {
          console.log(JSON.stringify({ ok: false, line: ++line, error: err.message }));
          if (err.name === 'BudgetExceeded') process.exit(1);
        }
      }
    });
  } else if (args[0] === 'price') {
    // tiny-budget price <model>
    const model = args[1];
    if (!model) {
      console.log(JSON.stringify(DEFAULT_PRICING, null, 2));
    } else {
      console.log(JSON.stringify({ [model]: DEFAULT_PRICING[model] || null }, null, 2));
    }
  } else {
    console.log(`tiny-budget — AI cost/token budget enforcement
Usage:
  tiny-budget simulate --limit-usd=1.00 < charges.jsonl
  tiny-budget price [model]

Each line of charges.jsonl: {"model":"openai/gpt-4o-mini","tokensIn":120,"tokensOut":45,"label":"summary"}
`);
  }
}