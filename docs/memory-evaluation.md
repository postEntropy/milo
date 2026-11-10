# Memory evaluation

`npm run eval:memory` measures retrieval over 36 notes and a history log. Its original
answerable questions mostly share the notes' vocabulary. The separate reworded count
must be read alongside recall: high lexical recall does not establish semantic recall.

`npm run eval:memory -- --stress` adds 12 isolated cases: accented and decomposed
Unicode, corrections, negations, multiple constraints, unknown personal and project
values that share known entities, paraphrases, mixed languages, history-only decisions,
and evidence across sessions and gateways. Each case reports its question, expected
notes, returned notes, precision, recall and reciprocal rank in JSON output.

An exact evidence pass requires every expected note and no unrelated notes. A question
with no evidence passes only if retrieval returns nothing. This is deliberately stricter
than answer accuracy: related but insufficient notes can help a model understand the
question, and returning them does not establish that the model will hallucinate an answer.

The cases write directly to real temporary SQLite stores and history logs. They check
the actual stored count and clean up their files. Corrections are seeded as independent
facts using `preserveDistinct`; this evaluates retrieval, not extraction, duplicate review,
or whether a model can decide which preference is current. No personal store is modified.

## Reproduce

```bash
npm run eval:memory
npm run eval:memory -- --stress
npx tsx scripts/eval-memory.ts --stress --json > memory-stress.json
MILO_EVAL_PACE_MS=3200 npx tsx scripts/eval-memory.ts --stress --semantic --coverage-only --json > memory-stress-semantic.json
```

`--semantic` uses the configured embedder, local or hosted, and can incur its normal
cost. It starts no engine. `--coverage-only` skips the unfiltered baseline;
`--no-coverage` skips the filtered configuration. These switches are mutually exclusive.
A hosted free model may require pacing. Stress results are withheld and the process fails
if any embedding request failed, so lexical fallback cannot masquerade as semantic recall.
The ordinary evaluation also withholds affected semantic rows.

## Findings, 2026-11-09

The original keyword evaluation with coverage retained 97.0% recall, 73.5% precision and
0/13 reworded hits after the changes. The filtered keyword store passes 9/12 exact evidence
cases in the new set. The remaining failures are a vocabulary-only paraphrase and two
unknown values whose entities match known notes. The two history cases pass.

A paced run with OpenRouter's `nvidia/nemotron-3-embed-1b:free` completed without
embedding failures. [The complete results](evals/memory-stress-2026-11-09.json) preserve
the expected and returned evidence for every case.

| Filtered configuration | Exact evidence | All expected evidence found | Empty on unknown values/questions |
| --- | --- | --- | --- |
| Keyword | 9/12 | 8/9 answerable cases | 1/3 |
| Keyword plus embeddings | 6/12 | 9/9 answerable cases | 0/3 |

Embeddings recover the missing paraphrase but add irrelevant notes, including on the
unrelated question. The exact-evidence score therefore falls even though answerable-case
recall improves. Neither score proves how an answering model will use that evidence.
A relevance gate needs independent validation; these twelve cases are too small to choose
and advertise a universal similarity threshold.

The evaluation exposed and led to these fixes:

- Coverage now folds accents and composed/decomposed Unicode consistently with FTS search.
- English question scaffolding such as `my` and `what` no longer qualifies an unrelated note.
- Semantic filling checks the retained lexical candidates after coverage, so discarded matches
  do not prevent an embedding request. Its candidate window accounts for lexical duplicates
  so they cannot consume all available semantic slots. Retained lexical notes still come first.
- The original fixture counts stored rows instead of reporting the number it attempted to seed.
  Scoring counts repeated evidence once, so duplicates cannot inflate recall above one.

The semantic control-flow tests use deterministic vectors to verify filling and request
avoidance. Those tests do not measure a real embedding model's quality. Real-model results
must come from `--semantic`, with no failed requests.

These sets are development diagnostics, not a public benchmark or evidence of state-of-the-art
performance. They do not measure end-to-end answer accuracy, automatic fact extraction,
current-value selection, long-context temporal reasoning, or cost at large scale. A comparable
LongMemEval or LoCoMo run must hold the dataset, answering model, prompts, token budget and
judging protocol fixed and report extraction, retrieval and answer failures separately.

## Validation

The memory integration and regression tests pass, as do root type checking and lint
(with an existing stylesheet specificity warning). The full suite reports 2,667 passing
tests and one existing failure: the palette convention parser expects the closing
parenthesis immediately after `darkAccentOn`, while the unchanged iOS palette entries
include `userBubbleText`. Neither the convention test nor the iOS theme was changed here.
