// Single-source cut-edit transforms — the pure core of VS-102 (docs/desktop-app-single-source.md).
//
// The single-source Review surface lets a user trim / reorder / drop the clips of a cut spec
// (cut.json — { project, clips: [{ source, in, out, audio }] }) before export. These are the
// immutable transforms behind that UI: each returns a NEW cut (never mutates its input) and is
// a no-op when the operation doesn't apply (out-of-range index, empty range), so the surface
// can call them freely. No I/O — the host reads/writes cut.json around them. Unit-tested to 100%.

// The clips array of a cut spec, tolerating a malformed/missing one. Pure.
function clipsOf(cut) {
  return cut && Array.isArray(cut.clips) ? cut.clips : [];
}

function withClips(cut, clips) {
  return { ...cut, clips };
}

// Remove the clip at `index`. Out-of-range → unchanged. Pure.
export function dropClip(cut, index) {
  const clips = clipsOf(cut);
  if (!Number.isInteger(index) || index < 0 || index >= clips.length) return cut;
  return withClips(cut, clips.filter((_, i) => i !== index));
}

// Move the clip at `from` to position `to` (FIFO splice). Out-of-range or from===to → unchanged.
// Pure.
export function reorderClip(cut, from, to) {
  const clips = clipsOf(cut);
  const n = clips.length;
  if (
    !Number.isInteger(from) ||
    !Number.isInteger(to) ||
    from < 0 ||
    from >= n ||
    to < 0 ||
    to >= n ||
    from === to
  ) {
    return cut;
  }
  const next = clips.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return withClips(cut, next);
}

// Set the in/out of the clip at `index` (either omitted → keep current). `in` is clamped to
// >= 0; the edit is rejected (unchanged) when the resulting range is non-positive (out <= in).
// Out-of-range index → unchanged. Pure.
export function trimClip(cut, index, { in: inSec, out: outSec } = {}) {
  const clips = clipsOf(cut);
  if (!Number.isInteger(index) || index < 0 || index >= clips.length) return cut;
  const cur = clips[index];
  const nextIn = Math.max(0, Number.isFinite(inSec) ? inSec : cur.in);
  const nextOut = Number.isFinite(outSec) ? outSec : cur.out;
  if (!(nextOut > nextIn)) return cut;
  const next = clips.slice();
  next[index] = { ...cur, in: nextIn, out: nextOut };
  return withClips(cut, next);
}

// Total runtime of the cut = sum of each clip's (out - in), floored at 0 per clip. Pure.
export function cutDuration(cut) {
  return clipsOf(cut).reduce((s, c) => s + Math.max(0, (c.out || 0) - (c.in || 0)), 0);
}
