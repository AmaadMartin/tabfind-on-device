# Eval

```bash
npm run eval
```

Compares two ways of finding a tab with a small model:

- **A — naive**: one prompt, all 40 tab titles, "pick the best three".
- **B — pipeline**: expand → BM25 prefilter → per-candidate scoring.

Reports recall@3, recall@3 on the zero-lexical-overlap subset, model calls, and
latency.

## Read the output before quoting it

Without a real on-device model the harness falls back to the scripted stand-in
and says so. In that mode the arms tie, and the naive arm is strictly cheaper —
because the stand-in has no long-context weakness to expose. That is the honest
result and it should not be dressed up.

The pipeline is a **quality mechanism for models that cannot rank forty items in
one context**, not a speed optimisation. Against a single prompt it makes roughly
eight times as many calls. Demonstrating its benefit requires the real model, on
a machine that has one.
