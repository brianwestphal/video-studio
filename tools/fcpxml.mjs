// Pure FCPXML generation for the editor handoff (docs/editor-handoff.md §6):
// turn an export manifest into a Final Cut Pro X project XML that lays the
// segments on the primary storyline and attaches each overlay as a connected
// clip above its segment. No I/O — `assetSrc(file)` supplies each clip's URL —
// so the XML/time math is fully unit-tested.

export const FCPXML_VERSION = "1.10"; // FCP 10.5+

// Standard Euclidean gcd. Always called with a frame-duration denominator ≥ 1,
// so the result is ≥ 1 (never 0).
function gcd(a, b) {
  a = Math.abs(a); b = Math.abs(b);
  while (b) { [a, b] = [b, a % b]; }
  return a;
}

// fps → FCP frameDuration {num, den}. Integer rates → 1/fps; NTSC rates
// (fps ≈ round*1000/1001) → 1001/(round*1000), e.g. 29.97 → 1001/30000.
export function frameDuration(fps) {
  const r = Math.round(fps);
  if (Math.abs(fps - r) < 0.001) return { num: 1, den: r };
  if (Math.abs(fps - (r * 1000) / 1001) < 0.01) return { num: 1001, den: r * 1000 };
  return { num: 1, den: r }; // best effort
}

// Seconds → an exact, frame-aligned FCP rational time string ("2s", "1001/30000s").
export function rationalTime(seconds, fps) {
  const fd = frameDuration(fps);
  const frames = Math.round(seconds * fps);
  let num = frames * fd.num;
  let den = fd.den;
  const g = gcd(num, den);
  num /= g; den /= g;
  return den === 1 ? `${num}s` : `${num}/${den}s`;
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const baseName = (p) => p.split("/").pop().replace(/\.[^.]+$/, "");

// Build the FCPXML document. `manifest` is the export manifest (see
// export-manifest.mjs); `assetSrc(file)` returns the media URL for a manifest
// file path (e.g. "segments/seg-001.mov" → "file:///…/segments/seg-001.mov").
export function buildFcpxml(manifest, assetSrc) {
  const { project, segments, overlays } = manifest;
  const fps = project.fps;
  const T = (s) => rationalTime(s, fps);
  const fd = frameDuration(fps);

  // resources: one format + one asset per exported clip
  let rid = 1;
  const formatId = `r${rid++}`;
  const ref = new Map();
  const assetEls = [];
  const addAsset = (file, durationSeconds, hasAudio) => {
    const id = `r${rid++}`;
    ref.set(file, id);
    const audio = hasAudio ? ` hasAudio="1" audioSources="1" audioChannels="2" audioRate="48000"` : "";
    assetEls.push(
      `    <asset id="${id}" name="${esc(baseName(file))}" start="0s" duration="${T(durationSeconds)}" hasVideo="1" videoSources="1"${audio} format="${formatId}">\n` +
      `      <media-rep kind="original-media" src="${esc(assetSrc(file))}"/>\n` +
      `    </asset>`,
    );
  };
  segments.forEach((s) => addAsset(s.file, s.durationSeconds, true));
  overlays.forEach((o) => addAsset(o.file, o.durationSeconds, false));

  // spine: segments in order; overlays nested as connected clips (lane 1)
  const spine = segments.map((s) => {
    const conn = overlays
      .filter((o) => o.overSegment === s.index)
      .map((o) => {
        const localOffset = o.target.start.seconds - s.target.start.seconds; // parent-local
        return `        <asset-clip ref="${ref.get(o.file)}" lane="1" offset="${T(localOffset)}" name="${esc(baseName(o.file))}" start="0s" duration="${T(o.durationSeconds)}"/>`;
      });
    const open = `      <asset-clip ref="${ref.get(s.file)}" offset="${T(s.target.start.seconds)}" name="${esc(baseName(s.file))}" start="0s" duration="${T(s.durationSeconds)}" format="${formatId}" tcFormat="NDF">`;
    if (conn.length === 0) return open.replace(/>$/, "/>");
    return `${open}\n${conn.join("\n")}\n      </asset-clip>`;
  });

  const fdStr = `${fd.num}/${fd.den}s`; // frameDuration's denominator is the fps, never 1
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<!DOCTYPE fcpxml>\n` +
    `<fcpxml version="${FCPXML_VERSION}">\n` +
    `  <resources>\n` +
    `    <format id="${formatId}" frameDuration="${fdStr}" width="${project.width}" height="${project.height}" colorSpace="1-1-1 (Rec. 709)"/>\n` +
    `${assetEls.join("\n")}\n` +
    `  </resources>\n` +
    `  <library>\n` +
    `    <event name="video-studio export">\n` +
    `      <project name="${esc(project.name)}">\n` +
    `        <sequence format="${formatId}" duration="${T(project.totalSeconds)}" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">\n` +
    `          <spine>\n` +
    spine.map((l) => l.split("\n").map((x) => `    ${x}`).join("\n")).join("\n") + "\n" +
    `          </spine>\n` +
    `        </sequence>\n` +
    `      </project>\n` +
    `    </event>\n` +
    `  </library>\n` +
    `</fcpxml>\n`
  );
}
