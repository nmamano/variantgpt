# VariantGPT

Chat UI where every word of the answer is colored by how probable it was —
white = certain, amber = wobbly, red = shaky. Click a colored word to see the
alternatives the model considered and branch the reply from that point.

Motivation: uncertain words are where to look for hallucinations.

## Two selectable backends (header dropdown)

| | `claude · probes` | `openai · logprobs` |
|---|---|---|
| Auth | Claude subscription (headless `claude -p`, Haiku) | `OPENAI_API_KEY` in `.env` |
| Probabilities | Estimated by sampling: K probe calls predict each stretch of the answer; agreement = confidence (Anthropic exposes no logprobs) | Exact per-token probabilities from `logprobs: true` |
| Alternatives | Divergent probe continuations — word + rest of sentence | Top alternative tokens with exact % |
| Speed | Slow (many model calls, bounded by 90s deadline + call budget) | Instant (single call) |

## Run

```sh
bun run server.ts   # http://0.0.0.0:4777
```

For the openai backend, put `OPENAI_API_KEY=sk-...` in `~/nil/redgpt/.env`
(picked up per-request, no restart needed). Optional: `OPENAI_MODEL=...`
(default `gpt-4o-mini`).

## How the claude sampling estimator works

1. Generate the full answer normally (one call).
2. Fire "anchor" probes every 9 words, each predicting the next ~18 words
   (2 probes per anchor). Compare probe output word-by-word against the real
   answer until first divergence — one matching stretch confirms many words in
   one call; a divergence marks the word and its alternative continuation.
3. Uncovered positions get shallow follow-up probes, all pipelined,
   under a hard call budget (20) and wall-clock deadline (90s); per-call 22s
   timeout so a stalled call can't hog a slot. Leftovers render as dotted
   "unknown". A stop button halts probing for a reply.

Branching regenerates the tail after the chosen alternative and re-probes only
the new part; each reply keeps a navigable list of branches (‹ ›).
