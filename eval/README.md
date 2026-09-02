# ExplainIT explanation-quality eval

Goal item 13: measure the quality of the explanations with a built-in test and refuse any change to
the prompts that makes them worse. Method: HumanEvalExplain-style round trip
(https://arxiv.org/abs/2308.07124) on 12 MIT-licensed HumanEval problems (`humaneval-subset.json`,
notice in `LICENSE-humaneval.txt`).

For every problem, per channel:

1. **explain** — the canonical solution (signature + body, docstring removed) goes through the real
   generation router and its real prompts.
2. **style** — a deterministic check of the explanation against the contract (one-sentence summary
   ending with a period, 2–5 short steps, length caps, no banned jargon): `style.ts`.
3. **resynth** — the same assistant is asked to write the function again from ONLY the name, the
   signature, the file context and the explanation (never the original body): `resynth.ts`.
4. **test** — the HumanEval tests run on that code in a sandboxed Python 3 subprocess (fresh temp
   folder, isolated interpreter, sockets blocked, 10 s limit): `python.ts`.

Scores: `pass@1` = share of problems whose regenerated code passed; `style` = share of explanations
that passed the style check. An assistant error counts as a failed problem.

## Running it

```
npm run eval -- --channel claude --update-baseline
npm run eval -- --channel codex  --update-baseline
npm run eval -- --channel fake   --update-baseline     # scripted stand-in, no credits, deterministic
npm run eval -- --help
```

`claude` and `codex` use the CLIs you are signed in to (same resolution as the extension: setting →
PATH → bundled VS Code extension binary) and spend a little of your credits (12 problems × 2 short
calls). `copilot` cannot run from a terminal because it lives behind VS Code's language model API.
Python 3 must be on PATH.

Each run writes `results/<channel>-<timestamp>.json` (ignored by git) and prints a table.
`--update-baseline` folds the scores into `baseline.json`:

```
{ promptHash, scores: { <channel>: { passAt1, style, n, ranAt } }, history: [ ...snapshots, newest last ] }
```

## The CI lock

`baseline.test.ts` (part of `npm run test:unit`) fails when

- `router.promptHash()` differs from `baseline.promptHash` — *Prompts changed without re-running the
  eval: run npm run eval -- --channel <c> --update-baseline*, or
- for any channel present in the two newest history entries, `passAt1` or `style` went down —
  *Explanation quality dropped for <channel>: … refusing this prompt change.*

`style.test.ts` runs the style checker against the recorded explanations in `fixtures/explanations.json`
(well-formed ones plus deliberately bad ones marked `expectedStyleOk: false`).

## The fake channel

`fixtures/fake-claude.js` mimics `claude -p --output-format json`. It answers explain prompts with
well-formed text and resynth prompts with the canonical solution looked up by function name, except
the last problem of the subset, which it gets wrong on purpose. It proves every stage of the harness
(fake pass@1 is 11/12 by construction) and says nothing about model quality.
