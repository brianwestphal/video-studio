import type { SafeHtml } from "./kerf.js";
import { attr, each } from "./kerf.js";

export const REVIEW_ACTIONS = {
  timelineToggle: attr("data-action", "timeline-toggle"),
  repropose: attr("data-action", "repropose"),
  save: attr("data-action", "save"),
  pick: attr("data-action", "pick"),
  audio: attr("data-action", "audio"),
  fullscreen: attr("data-action", "fullscreen"),
  segmentPlay: attr("data-action", "segment-play"),
  segmentSeek: attr("data-action", "segment-seek"),
  note: attr("data-action", "note"),
} as const;

export interface ReviewCandidate {
  id: string;
  url: string;
  auto?: boolean;
}

export interface ReviewSegment {
  index: number;
  atSeconds: number;
  endSeconds: number;
  previewStart: number;
  previewEnd: number;
  chosen: string;
  pick: string;
  note: string;
  why?: string;
  confidence?: number | null;
  forced?: boolean;
  candidates: ReviewCandidate[];
}

export const fmt = (seconds: number): string =>
  `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
export const fmt1 = (seconds: number): string =>
  `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(1).padStart(4, "0")}`;

export function sectionPercent(segment: ReviewSegment, time: number): number {
  const duration = segment.previewEnd - segment.previewStart;
  if (duration <= 0) return 0;
  return Math.max(0, Math.min(100, ((time - segment.previewStart) / duration) * 100));
}

export function ReviewHeader(props: { groupId: string; count: number; canRepropose: boolean; status: string }): SafeHtml {
  return <header data-key="review-header">
    <div>
      <h1>Review <span id="count">{props.count}</span> cut(s) — {props.groupId}</h1>
      <div class="legend">On the scrubber, the <span class="swatch"></span> band is the shot this cut introduces; the clip ends are ±context lead-in/out.</div>
    </div>
    <div class="review-actions">
      <button id="tltoggle" {...REVIEW_ACTIONS.timelineToggle.attrs}>▸ Timeline</button>
      <span id="status">{props.status}</span>
      {props.canRepropose ? <button id="repropose" {...REVIEW_ACTIONS.repropose.attrs} title="Re-flow the un-locked cuts around your picks">Re-propose downstream</button> : ""}
      <button {...REVIEW_ACTIONS.save.attrs}>Save picks</button>
    </div>
  </header>;
}

function CandidateCard({ segment, candidate }: { segment: ReviewSegment; candidate: ReviewCandidate }): SafeHtml {
  const selected = candidate.id === segment.pick;
  return <div class={`cand${selected ? " sel" : ""}${candidate.auto ? " auto" : ""}`} data-key={candidate.id} data-candidate={candidate.id}>
    <video data-morph-skip="" src={candidate.url} muted playsInline preload="auto"></video>
    <div class="tag"><span>{candidate.id}</span><span>{candidate.auto ? "auto" : ""}</span></div>
    <div class="ctl">
      <button class={selected ? "on" : ""} {...REVIEW_ACTIONS.pick.attrs}>{selected ? "Picked" : "Pick"}</button>
      <button class={selected ? "on" : ""} {...REVIEW_ACTIONS.audio.attrs}>Audio</button>
      <button {...REVIEW_ACTIONS.fullscreen.attrs}>Full</button>
    </div>
  </div>;
}

export function SegmentCard(segment: ReviewSegment): SafeHtml {
  const bandStart = sectionPercent(segment, segment.atSeconds);
  const bandEnd = sectionPercent(segment, segment.endSeconds);
  return <section class="seg" data-key={segment.index} data-segment={segment.index}>
    <h2>Cut at {fmt(segment.atSeconds)} — auto picked <code>{segment.chosen}</code>{segment.forced ? <em> (added for review)</em> : ""}</h2>
    <p class="why">{segment.why || ""} · confidence <code>{segment.confidence ?? "?"}</code> · section <code>{fmt1(segment.atSeconds)}–{fmt1(segment.endSeconds)}</code></p>
    <div class="transport">
      <button class="pp" {...REVIEW_ACTIONS.segmentPlay.attrs}>Play</button>
      <div class="seekwrap">
        <div class="track"></div>
        <div class="band" style={`left:${bandStart}%;width:${Math.max(0, bandEnd - bandStart)}%`}></div>
        <div class="cut" style={`left:${bandStart}%`}></div>
        <input class="seek" {...REVIEW_ACTIONS.segmentSeek.attrs} type="range" min="0" max="1000" value="0" step="1" />
      </div>
      <span class="time">0:00 / 0:00</span>
    </div>
    <div class="cands">{/* eslint-disable-next-line kerfjs/require-data-key-in-each -- CandidateCard's root carries the candidate key. */}
      {each(segment.candidates, (candidate) => <CandidateCard segment={segment} candidate={candidate} />)}
    </div>
    <input class="note" {...REVIEW_ACTIONS.note.attrs} value={segment.note} placeholder="note (optional) — why this angle?" />
  </section>;
}

export function ReviewSegments({ segments }: { segments: ReviewSegment[] }): SafeHtml {
  return <main id="root">
    {each(segments, SegmentCard)}
  </main>;
}
