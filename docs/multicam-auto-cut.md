# Auto multi-cam angle selection

Status: **Shipped** — the selector (**VS-46**, `tools/multicam-autocut.mjs` pure +
100% tested, `propose-switches` CLI) and its workflow integration (**VS-47**,
`--switches` on `export-multicam-fcpxml`/`render-multicam-preview` + the skill
auto-cut step) are built; the BYAM demonstration (§6) remains a manual run. This
doc began as VS-43 research synthesizing [`audio-events.md`](audio-events.md)
(VS-41) + [`visual-saliency.md`](visual-saliency.md) (VS-42) into a
switch-generation algorithm. See [`multicam.md`](multicam.md) R-MC7.

## 1. Problem

Given a synced group (`multicam.json`), the audio-events timeline
(`audio-events.json`), and per-angle visual saliency, decide **which angle is on
screen at each moment** and emit a `switches` list. The output must drop straight
into the existing consumers — `buildMulticamFcpxml` /
`export-multicam-fcpxml.mjs` and `expandMulticamGroup` — which already take
`switches: [{ atSeconds, memberId }]` on the group clock. The selector adds a
**rationale** per switch so the user can see *why* it cut there.

It must fix the two issues the maintainer flagged on the hand edit: favor the
**guitar during riffs**, and stop sitting on the **singer who isn't singing**.

## 2. Strategies considered

1. **Pure rule priority** — `instrumental` event → highest-`instrument` angle;
   `vocal` event → highest-`performer`/"singing" angle; else highest `saliency`.
   *Simple and explainable, but brittle and cuts erratically (no rhythm/variety).*
2. **Weighted per-window scoring** — each (angle, window) gets a score combining
   audio context + visual saliency; pick the max per window, then **smooth** into
   shots. *Good balance; tunable; still explainable via the score breakdown.*
3. **Global cost optimization (DP/Viterbi)** — minimize a cost = −quality +
   switch-penalty + min/max-shot penalties over the whole timeline. *Best shot
   rhythm, but heavier and harder to explain.*

**Recommendation: (2) weighted scoring + constraint smoothing**, with the option
to graduate the smoothing to (3) Viterbi later if the greedy pass cuts poorly. (1)
becomes the special-case priors *inside* the weights.

## 3. Recommended algorithm

Work on the aligned window grid from VS-42 (`windowSeconds`, group clock).

**Step A — per-window, per-angle score.** For window *w* and angle *a*:

```
score(a,w) = wPerf·perf(a,w) + wInst·inst(a,w)·isInstrumental(w)
           + wVocal·perf(a,w)·isVocal(w)      // "active singer" during vocals
           + wMotion·motion(a,w) + wFraming·framing(a,w)
           − shotTypeRepeatPenalty·[shotType(a,w) == outgoing shot type]  // variety (VS-66)
```
- `isInstrumental(w)`/`isVocal(w)` come from the `audio-events` kinds covering *w*
  → this is what makes riffs favor the **instrument** angle and vocals favor the
  **active-singer** angle, data-driven (no hardcoded camera roles).
- Angles with **no footage** at *w* (window before the member's offset, or after
  its end) score −∞ (never chosen) — uses `multicam.json` offsets/durations.

**Step B — pick + smooth into shots.** Greedy argmax per window, then enforce
editorial constraints:
- **minimum shot length** — don't switch unless the new angle has led by a margin
  for ≥ `minShotSeconds` (hysteresis), killing flicker;
- **maximum shot length / variety** — force a cut (to the next-best valid angle)
  after `maxShotSeconds` of the same angle;
- **long-take exception** — during a sustained *instrumental* stretch, a clearly
  dominant angle (leading the runner-up by ≥ `longTakeMargin`) may hold past
  `maxShotSeconds`, up to `longTakeMaxSeconds`, instead of being force-cut — so
  guitar solos / intentional "oner" shots aren't chopped. Vocal holds are never
  extended (they still cut at `maxShotSeconds`), and the maintainer can always
  hand-edit `switches.json` for a longer take;
- **shot-type variety** (VS-66) — when picking a *fresh* angle (a forced or normal
  cut), a soft `shotTypeRepeatPenalty` discourages a candidate whose shot size
  (wide / medium / close, from `shotTypeOf` — an explicit `shotType` or a label hint)
  matches the outgoing shot, so the edit doesn't sit on two similar shots in a row.
  Best-effort: no penalty where the shot type is unknown;
- **locks** (VS-66) — `autoCut({ …, locks: [{ atSeconds, memberId }] })` pins a
  user-confirmed pick at its window and lets the selection re-flow around it (the
  review UI's downstream re-evaluation, R-RUI7);
- **cut-on-onset snapping** — when a switch is due, snap its time to the nearest
  `onset`/`section` boundary (VS-41) within `snapToleranceSeconds`.

**Step C — emit.** Collapse consecutive same-angle windows; emit one
`{ atSeconds, memberId }` per shot boundary + a `rationale` string (the dominant
term, e.g. "instrumental riff → guitar angle (inst 0.81)"). First switch at the
group start (or a `--start` trim, consistent with the export). A **runt trailing
shot** — a final switch landing within the model's min gap (`ws/2`) of the timeline
end, an artifact of onset snapping — is merged back into the previous shot rather
than emitted (VS-61).

## 4. Parameters (all CLI-tunable, sane defaults)

| Param | Default | Effect |
|-------|---------|--------|
| `minShotSeconds` | 0.5 | nominal floor on shot length; effective granularity is the saliency window (~1–2s) |
| `maxShotSeconds` | 8 | force variety after this (unless the long-take exception applies) |
| `longTakeMaxSeconds` | 16 | ceiling a dominant angle may hold to during a sustained instrumental stretch (R-AC8) |
| `longTakeMargin` | 0.15 | the held angle must beat the runner-up by at least this to qualify as a long take |
| `shotTypeRepeatPenalty` | 0.1 | soft penalty on a fresh pick whose shot size matches the outgoing shot (variety, VS-66) |
| `wPerf / wVocal / wInst / wMotion / wFraming` | tuned on BYAM | score weights |
| `snapToleranceSeconds` | 0.4 | cut-on-onset snap window |
| `windowSeconds` | from VS-42 | analysis granularity |
| `seed`/tie-break | input order | deterministic output |

Determinism matters (the pure module is unit-tested): same inputs + params →
identical `switches`.

## 5. Output shape

```jsonc
{
  "version": 1,
  "groupId": "byam",
  "switches": [ { "atSeconds": 0.0, "memberId": "byam-cam-1" }, … ],   // feeds the exporters AS-IS
  "rationale": [ {
    "atSeconds": 0.0, "memberId": "byam-cam-1",
    "why": "intro: only angle with footage / highest framing",
    "runnerUp": "byam-cam-2",   // 2nd-best available angle at the cut (null if none)
    "confidence": 0.7,          // min(normalized margin over runner-up, saliency confidence)
    "flagged": false            // true → surface for human review (R-AC9)
  }, … ]
}
```
`switches` is exactly the existing shape (no change to `buildMulticamFcpxml` /
`expandMulticamGroup`); `rationale` is parallel and optional for consumers — the
`runnerUp` / `confidence` / `flagged` fields are additive.

## 6. Evaluation plan

- **Qualitative:** run the generated `switches` through `render-multicam-preview`
  and compare side by side with the hand edit `external/multi-cam/BYAM-multicam-preview.mp4`;
  confirm the guitar intro holds on a guitar angle and vocals favor the active
  singer.
- **Quantitative (computable from the inputs, no human):**
  - % of `instrumental` time on the highest-`instrument` angle (want ↑);
  - % of `vocal` time on a "singing" angle (want ↑);
  - shot-length distribution vs `min/maxShotSeconds` (no sub-min shots);
  - switch count in a sane range vs the 32-cut hand edit.
- Tune the weights on BYAM, then sanity-check they generalize (don't overfit).

## 7. Requirements

- **R-AC1** A **pure** module consumes `multicam.json` + `audio-events.json` +
  the saliency schema and returns `{ switches, rationale }` (§5); `switches` is the
  existing shape and feeds `buildMulticamFcpxml`/`expandMulticamGroup` unchanged.
- **R-AC2** Selection honors footage availability (never pick an angle with no
  media at that time), `minShotSeconds`, `maxShotSeconds`, variety, and
  cut-on-onset snapping; all knobs are parameters with documented defaults.
- **R-AC3** Output is **deterministic** for given inputs+params; the module is
  unit-tested to **100%** (added to `vitest.config.ts`).
- **R-AC4** Each switch carries a human `rationale`.
- **R-AC5** Degrades gracefully: missing visual saliency → audio + footage only;
  missing audio events → saliency + footage only; neither → a sensible round-robin
  with `minShotSeconds` (never worse than today's manual default).
- **R-AC6** A thin CLI reads the three inputs and writes/prints the switches;
  ffmpeg/model work belongs to VS-44/45, not here.
- **R-AC7** *(VS-47)* The proposed `switches.json` feeds the R-MC6 handoff via
  **`--switches <switches.json>`** on `export-multicam-fcpxml` and
  `render-multicam-preview` (a plain `{ atSeconds, memberId }` list the maintainer
  can hand-edit to override); the per-switch `rationale` is surfaced on stdout by
  `propose-switches` and travels inside `switches.json`. Explicit `--switch` flags
  still win when both are supplied.
- **R-AC9** *(VS-63)* Each `rationale` entry carries a **review signal**: the
  `runnerUp` angle (2nd-best available at the cut, or null), a `confidence` in `[0,1]`
  (the lesser of the normalized score margin over the runner-up and the chosen
  window's saliency confidence), and a `flagged` boolean — true when the margin is
  below `reviewMarginThreshold` **or** the saliency confidence is below
  `reviewConfidenceThreshold` (generous by design). Consumed by the review UI
  ([`multicam-review-ui.md`](multicam-review-ui.md), R-RUI).
- **R-AC8** *(VS-62)* Shot-length policy: default `maxShotSeconds` **8** and
  `minShotSeconds` **0.5**. A **long-take exception** lets a clearly dominant angle
  (leading the runner-up by ≥ `longTakeMargin`) hold past `maxShotSeconds` up to
  `longTakeMaxSeconds` **only during instrumental context** (solos / oners); vocal
  holds always cut at `maxShotSeconds`. All four knobs are parameters with the
  documented defaults; the manual `switches.json` override still lets the maintainer
  force any longer take.

## 8. Follow-ups

- **VS-46** — implement R-AC1–R-AC6 (pure selector + CLI + tests + this schema). *(Shipped.)*
- **VS-47** — wire it into the skill/CLI end to end with manual override + surfaced
  rationale (R-AC7 / R-MC7). *(Shipped; BYAM demonstration run — favors guitar on
  riffs / singer on vocals.)*
- **VS-62** — shot-length policy: `maxShotSeconds` 12→8, `minShotSeconds` 2.0→0.5,
  and the instrumental long-take exception (R-AC8). *(Shipped.)*
- **VS-63/65** — review UI: per-switch flag signal (R-AC9) + `review-switches` to resolve
  flagged cuts by hand. *(Shipped.)*
- **VS-66** — `autoCut` `locks` (downstream re-evaluation) + shot-type variety penalty
  (R-RUI7); `shotType` added to the saliency vision schema. *(Shipped.)*
- **VS-64** — vision saliency mis-scores a non-singing musician as a performer. *(Open, low.)*
- **VS-67** — wire the review UI's save to re-propose downstream via `autoCut` locks. *(Planned.)*
