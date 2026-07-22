// Pure audio-boundary policy for hard cuts. Finding the nearest true zero crossing
// requires decoding source samples; command planners cannot inspect those samples, so
// they apply a tiny deterministic fade at every otherwise-unprotected boundary.

export const AUDIO_CUT_FADE_SECONDS = 0.005;

export function audioCutFadeFilter(durationSeconds, {
  offsetSeconds = 0,
  fadeIn = true,
  fadeOut = true,
} = {}) {
  const duration = Number(durationSeconds);
  if (!(duration > 0)) throw new Error("audio cut duration must be positive");
  const fade = Math.min(AUDIO_CUT_FADE_SECONDS, duration / 2);
  const filters = [];
  if (fadeIn) filters.push(`afade=t=in:st=${offsetSeconds}:d=${fade}`);
  if (fadeOut) filters.push(`afade=t=out:st=${offsetSeconds + duration - fade}:d=${fade}`);
  return filters.join(",");
}
