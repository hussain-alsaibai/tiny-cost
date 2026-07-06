# tiny-budget

> Zero-dependency runtime budget enforcement for AI agents. Tracks USD and
> token spend against per-task limits, throws when limits are crossed, and
> persists state so a crashed agent doesn't double-spend on restart.

```bash
npm install tiny-budget
```

## Why?

AI agents love to loop. A cron job that calls `openai.chat.completions` 200
times when it should call it 20 times is the canonical agent disaster. Most
teams discover this from a $400 invoice, not from their logs.

`tiny-budget` is the smallest thing that prevents that:

```js
const { Budget } = require('tiny-budget');

const budget = new Budget({
  path: '~/.myagent/run-2026-07-06/budget.json',
  taskId: 'cron:daily-bounty-work',
  limitUsd: 0.50,             // hard cap for this run
  warnAt: 0.7,                // fire onWarn at 70%
  onWarn: (rec) => console.warn(`budget warning: $${rec.spentUsd.toFixed(3)}`),
});

for (const issue of issues) {
  const r = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: summarize(issue.body) }],
  });
  budget.chargeUsage('openai/gpt-4o-mini', r.usage, issue.title);
}

console.log(budget.snapshot());
// { taskId, spentUsd: 0.0734, spentTokens: 87432, limitUsd: 0.50, ... }
```

When the budget is exceeded, `charge()` throws `BudgetExceeded` with the full
record attached so your agent can decide whether to abort, retry, or fall
back to a cheaper model.

## Features

- **USD + token limits** (either, both, or neither)
- **Atomic JSON persistence** (write-temp + rename) for crash safety
- **Per-task isolation** (different `taskId` = fresh budget)
- **Built-in pricing** for OpenAI, Anthropic, Google (override with `setPricing`)
- **`chargeUsage()`** accepts OpenAI-style (`prompt_tokens` / `completion_tokens`)
  or Anthropic-style (`input_tokens` / `output_tokens`) usage objects
- **`chargeFlat()`** for opaque-cost APIs (e.g. fixed-fee external services)
- **Warning callbacks** at a fraction of the limit (no spam: only fires once
  per crossed threshold)
- **CLI** for replaying charge logs or looking up pricing

## API

### `new Budget(opts)`

| Option | Type | Default | Purpose |
|---|---|---|---|
| `path` | string | `null` | JSON file for persistence |
| `taskId` | string | uuid | Unique id for this task run |
| `limitUsd` | number | `Infinity` | Hard USD cap |
| `limitTokens` | number | `Infinity` | Hard token cap |
| `warnAt` | 0..1 | `0.8` | Fire `onWarn` at this fraction |
| `pricing` | object | defaults | Per-model `{ input, output }` USD per 1K tokens |
| `autosave` | bool | `true` | Persist after every charge |
| `onWarn` | fn | `null` | Called once per crossed threshold |
| `onCharge` | fn | `null` | Called for every successful charge |

### Methods

- `charge(model, tokensIn, tokensOut, label?)` — record a model call
- `chargeUsage(model, usage, label?)` — convenience for `{prompt,completion}_tokens`
- `chargeFlat(usd, label?)` — record opaque-cost spend
- `snapshot()` — `{ taskId, spentUsd, spentTokens, limitUsd, limitTokens, remainingUsd, remainingTokens, charges }`
- `remainingUsd()` / `remainingTokens()` — convenience
- `reset(newTaskId?)` — start a new task (or same task)
- `setPricing(model, inputPer1k, outputPer1k)` — register custom pricing

### `BudgetExceeded`

```js
try {
  budget.charge('openai/gpt-4o', 1000, 1000);
} catch (err) {
  if (err.name === 'BudgetExceeded') {
    console.error(err.message);   // "Budget exceeded: $0.0200 > $0.0100 ..."
    console.error(err.record);   // full charge record for telemetry
  }
}
```

## CLI

```bash
# Print default pricing table
npx tiny-budget price

# Print pricing for one model
npx tiny-budget price openai/gpt-4o-mini

# Replay charge log against a budget limit
cat charges.jsonl | npx tiny-budget simulate --limit-usd=1.00
# Each line: {"model":"openai/gpt-4o-mini","tokensIn":120,"tokensOut":45,"label":"summary"}
```

## Persistence

`tiny-budget` writes to `<path>` after every charge using
`writeFileSync` to `<path>.tmp` + `renameSync`. On POSIX this is atomic;
on Windows it's "best effort atomic." Good enough for a single-process agent.

If the `taskId` in the saved file doesn't match the in-memory `taskId`,
`tiny-budget` ignores the file — a different task starts fresh. This means
you can safely point multiple crons at the same file with different task ids
and they won't clobber each other.

## Why not just use `openai/cost-tracker` or LangSmith?

Those are great when you have them. `tiny-budget` is for the cases where:

- You can't ship a SaaS dependency into a container
- You're calling 4 different providers and want one consistent cap
- You want a hard runtime check, not after-the-fact reporting
- You want the budget state to live in the same gitignored dir as the rest
  of your agent's state

It's also 280 lines including comments. You can read the whole thing.

## Tests

```bash
node test_tiny_budget.js
```

16 tests cover: pricing math, USD + token limits, persistence + reload,
per-task isolation, OpenAI/Anthropic usage shapes, warning/charge callbacks,
unknown model handling, custom pricing, flat charges, snapshot, reset, and
`withBudget` wrapper.

## License

MIT