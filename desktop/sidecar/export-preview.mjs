// Project source-clock audio events onto the edited output clock (VS-110).
const CONTENT_KINDS = new Set(["vocal", "instrumental", "quiet", "section"]);

export function buildPostEditAudioMap(audioEvents, cutSpec = null) {
  const events = Array.isArray(audioEvents?.events)
    ? audioEvents.events.filter((event) => CONTENT_KINDS.has(event.kind) && event.endSeconds > event.startSeconds)
    : [];
  const clips = Array.isArray(cutSpec?.clips) ? cutSpec.clips : null;
  if (!clips) return events.map((event) => ({ startSeconds: event.startSeconds, endSeconds: event.endSeconds, kind: event.kind, text: event.description || event.kind }));
  const projected = [];
  let outputStart = 0;
  for (const clip of clips) {
    const clipIn = Number(clip.in);
    const clipOut = Number(clip.out);
    for (const event of events) {
      const start = Math.max(clipIn, event.startSeconds);
      const end = Math.min(clipOut, event.endSeconds);
      if (end <= start) continue;
      projected.push({ startSeconds: outputStart + start - clipIn, endSeconds: outputStart + end - clipIn, kind: event.kind, text: event.description || event.kind });
    }
    outputStart += Math.max(0, clipOut - clipIn);
  }
  return projected;
}
