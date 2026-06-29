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

// A whole frame count → an exact FCP rational time string ("2s", "1001/30000s").
// Spine builders that need clip offsets to sum *exactly* must work in whole
// frames and call this directly: rounding each clip's offset and duration
// independently from seconds yields 1-frame spine gaps/overlaps at non-integer
// rates (T(a) + T(b−a) ≠ T(b) once round(·*fps) is involved).
export function framesToTime(frames, fps) {
  const fd = frameDuration(fps);
  let num = frames * fd.num;
  let den = fd.den;
  const g = gcd(num, den);
  num /= g; den /= g;
  return den === 1 ? `${num}s` : `${num}/${den}s`;
}

// Seconds → an exact, frame-aligned FCP rational time string ("2s", "1001/30000s").
export function rationalTime(seconds, fps) {
  return framesToTime(Math.round(seconds * fps), fps);
}

// The audio sample rate we declare on every asset (`audioRate="48000"`).
export const AUDIO_RATE = 48000;

// Seconds → an exact, AUDIO-SAMPLE-aligned rational time string. Audio media in
// FCP is sample-based, and FCP is strict at audio media boundaries: an audio
// asset whose `duration` is video-frame-quantized (e.g. 2881879/12000s) lands
// between samples and slightly SHORT of the real media, so a full-length audio
// edit reads as "Invalid edit with no respective media" on import. Declaring the
// audio asset's duration sample-exactly (e.g. 120081/500s) makes the media cover
// the frame-aligned clip edits with room to spare.
export function audioTime(seconds, rate = AUDIO_RATE) {
  let num = Math.round(seconds * rate);
  let den = rate; // always >= 1, so gcd is >= 1 (never 0)
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
  const { project, segments, overlays, audioTrack } = manifest;
  const fps = project.fps;
  const T = (s) => rationalTime(s, fps);
  const fd = frameDuration(fps);

  // resources: one format + one asset per exported clip
  let rid = 1;
  const formatId = `r${rid++}`;
  const ref = new Map();
  const assetEls = [];
  const addAsset = (file, durationSeconds, hasAudio, hasVideo = true) => {
    const id = `r${rid++}`;
    ref.set(file, id);
    const audio = hasAudio ? ` hasAudio="1" audioSources="1" audioChannels="2" audioRate="48000"` : "";
    const video = hasVideo ? ` hasVideo="1" videoSources="1"` : "";
    // `format` is a VIDEO format — only video assets carry it. An audio-only asset
    // (the master-audio track) with a video format makes FCP look for nonexistent
    // frames and reject the edit ("Invalid edit with no respective media").
    const format = hasVideo ? ` format="${formatId}"` : "";
    // Audio media is sample-based: declare an audio-only asset's duration
    // sample-exactly so it covers the frame-aligned clip edits (see audioTime).
    const dur = hasVideo ? T(durationSeconds) : audioTime(durationSeconds);
    assetEls.push(
      `    <asset id="${id}" name="${esc(baseName(file))}" start="0s" duration="${dur}"${video}${audio}${format}>\n` +
      `      <media-rep kind="original-media" src="${esc(assetSrc(file))}"/>\n` +
      `    </asset>`,
    );
  };
  segments.forEach((s) => addAsset(s.file, s.durationSeconds, true));
  overlays.forEach((o) => addAsset(o.file, o.durationSeconds, false));
  // The continuous master-audio track (multi-cam) is an audio-only asset.
  if (audioTrack) addAsset(audioTrack.file, audioTrack.durationSeconds, true, false);

  // spine: segments in order; overlays nested as connected clips (lane 1)
  const spine = segments.map((s) => {
    const conn = overlays
      .filter((o) => o.overSegment === s.index)
      .map((o) => {
        const localOffset = o.target.start.seconds - s.target.start.seconds; // parent-local
        return `        <asset-clip ref="${ref.get(o.file)}" lane="1" offset="${T(localOffset)}" name="${esc(baseName(o.file))}" start="0s" duration="${T(o.durationSeconds)}"/>`;
      });
    // The master audio is a connected clip on lane -1 of the first segment,
    // spanning the whole sequence (offset 0 = timeline start, since seg 1 is at 0).
    if (audioTrack && s.index === 1) {
      conn.unshift(`        <asset-clip ref="${ref.get(audioTrack.file)}" lane="-1" offset="0s" name="${esc(baseName(audioTrack.file))}" start="0s" duration="${T(audioTrack.durationSeconds)}"/>`);
    }
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

// Build a Final Cut Pro **multicam** FCPXML from a synced group (docs/multicam.md
// R-MC6): a `<media>`/`<multicam>` with one `<mc-angle>` per synced member (each
// angle's clip placed at its sync offset), then a `<mc-clip>` per angle-switch
// span on the spine, each selecting the active video angle + the fixed master
// audio angle via `<mc-source>`. The result is a LIVE multicam clip the user can
// re-cut in FCP's angle viewer — it references the ORIGINAL member media (not
// exported segments). `assetSrc(path)` resolves a member path to a media URL.
//
//  - `group`: a multicam manifest group ({ projectFps, masterAudioId, members[] }).
//  - `switches`: [{ atSeconds, memberId }] over the shared timeline (empty → one
//    mc-clip spanning the whole timeline on the first video angle).
//  - `opts`: { name, width, height, totalSeconds?, startSeconds? }. `totalSeconds`
//    defaults to the master audio member's duration. `startSeconds` (default 0)
//    trims leading dead air: the group-timeline moment `startSeconds` becomes
//    timeline 0, so the edit (and the master audio under it) begins where the
//    footage is. This matters in FCP — when the master audio runs *before* the
//    first video frame, FCP's multicam plays the audio ahead of the picture;
//    starting the edit where the cameras are rolling keeps audio and picture
//    locked (the flat preview tolerates the lead, FCP does not — VS-36).
export function buildMulticamFcpxml(group, switches, { name, width, height, totalSeconds, startSeconds } = {}, assetSrc) {
  const fps = group.projectFps;
  const T = (s) => rationalTime(s, fps);
  const fd = frameDuration(fps);
  const fdStr = `${fd.num}/${fd.den}s`;
  const members = group.members;
  const master = members.find((m) => m.id === group.masterAudioId);
  if (!master) throw new Error(`master audio member not found: ${group.masterAudioId}`);
  const total = totalSeconds ?? master.durationSeconds;
  if (!(total > 0)) throw new Error("buildMulticamFcpxml: a positive totalSeconds (or master duration) is required");
  const origin = startSeconds ?? 0; // group-time that maps to timeline 0 (dead-air trim)
  if (origin < 0 || origin >= total) throw new Error(`buildMulticamFcpxml: startSeconds must be in [0, ${total})`);
  const timelineLength = total - origin;

  // Shift the whole multicam timeline so the earliest angle sits at offset 0
  // (FCP angle offsets must be ≥ 0); a group-timeline moment T maps to multicam
  // time T + shift.
  const offsetOf = (m) => m.offsetSeconds ?? 0;
  const minOffset = Math.min(...members.map(offsetOf));
  const shift = minOffset < 0 ? -minOffset : 0;

  let rid = 1;
  const formatId = `r${rid++}`;
  const assetId = new Map();
  for (const m of members) assetId.set(m.id, `r${rid++}`);
  const mediaId = `r${rid++}`;

  const assetEls = members.map((m) => {
    const isVideo = m.kind !== "audio";
    const v = isVideo ? ` hasVideo="1" videoSources="1"` : "";
    const a = ` hasAudio="1" audioSources="1" audioChannels="2" audioRate="48000"`;
    // A `format` (frameDuration/width/height) is a VIDEO format — putting it on an
    // audio-only asset makes FCP treat it as video, look for frames, find none, and
    // reject every edit that uses it ("Invalid edit with no respective media").
    const fmt = isVideo ? ` format="${formatId}"` : "";
    // Audio media is sample-based: declare an audio-only asset's duration
    // sample-exactly so it covers the frame-aligned clip edits (see audioTime).
    const dur = isVideo ? T(m.durationSeconds) : audioTime(m.durationSeconds);
    return (
      `    <asset id="${assetId.get(m.id)}" name="${esc(baseName(m.path))}" start="0s" duration="${dur}"${v}${a}${fmt}>\n` +
      `      <media-rep kind="original-media" src="${esc(assetSrc(m.path))}"/>\n` +
      `    </asset>`
    );
  });

  const angleEls = members.map((m) => {
    const off = offsetOf(m) + shift;
    const fmt = m.kind !== "audio" ? ` format="${formatId}"` : "";
    return (
      `      <mc-angle name="${esc(m.id)}" angleID="${esc(m.id)}">\n` +
      `        <asset-clip ref="${assetId.get(m.id)}" offset="${T(off)}" name="${esc(baseName(m.path))}" start="0s" duration="${T(m.durationSeconds)}"${fmt}/>\n` +
      `      </mc-angle>`
    );
  });
  const mediaDuration = Math.max(...members.map((m) => offsetOf(m) + shift + (m.durationSeconds || 0)));

  // The angle-switch spans → one mc-clip each. Default to a single span on the
  // first video angle (or the first member) when no switches are given.
  const firstVideo = members.find((m) => m.kind !== "audio") || members[0];
  const sorted = (switches && switches.length ? [...switches] : [{ atSeconds: 0, memberId: firstVideo.id }]).sort((a, b) => a.atSeconds - b.atSeconds);
  const byId = new Map(members.map((m) => [m.id, m]));
  // Lay the spine on whole-frame boundaries so consecutive clips are EXACTLY
  // contiguous: clip i ends at frame round(tOut*fps), which is exactly where
  // clip i+1 begins. Computing offset/duration independently via T(seconds)
  // drifts by ±1 frame at non-integer rates and FCP mis-positions the spine.
  const frameOf = (s) => Math.round(s * fps);
  const Tf = (frames) => framesToTime(frames, fps);
  // The master audio plays under the WHOLE timeline as a connected clip on lane
  // -1 of the first mc-clip — the same pattern as the flat export's audioTrack
  // (buildFcpxml). Routing the audio through an mc-source `srcEnable="audio"`
  // instead leaves the timeline silent on import (FCP doesn't sound the audio
  // angle that way), so the spine mc-clips select VIDEO only and the timeline
  // takes its audio solely from this connected clip — no doubled angle audio.
  const masterAssetRef = assetId.get(group.masterAudioId);
  // The master audio under the timeline plays from group-time `origin`; in its own
  // clock that is `origin - masterOffset` (0 for a reference master at offset 0).
  const masterOffset = offsetOf(master);
  const audioStartSec = origin - masterOffset;
  const audioDur = Math.min(timelineLength, (master.durationSeconds ?? (audioStartSec + timelineLength)) - audioStartSec);

  // Validate every switch up front (so an unknown angle still throws even when the
  // trim would drop its span), then clip the spans to [origin, total] and re-base
  // them to a timeline starting at 0.
  for (const sw of sorted) if (!byId.has(sw.memberId)) throw new Error(`unknown memberId: ${sw.memberId}`);
  const spans = [];
  for (let i = 0; i < sorted.length; i++) {
    const tOut = Math.min(i + 1 < sorted.length ? sorted[i + 1].atSeconds : total, total);
    if (tOut <= origin) continue; // span ends before the trim point
    const tIn = Math.max(sorted[i].atSeconds, origin);
    if (tIn >= tOut) continue; // empty after clamping
    spans.push({ memberId: sorted[i].memberId, tIn, tOut });
  }

  const clipEls = spans.map((sp, i) => {
    const inF = frameOf(sp.tIn - origin); // timeline position (re-based to the trim point)
    const outF = frameOf(sp.tOut - origin);
    const srcStartF = frameOf(sp.tIn + shift); // source time within the multicam media
    // offset="0s" is parent-local: the first mc-clip sits at timeline 0, so the
    // master audio starts at the timeline zero, playing from its own `audioStartSec`.
    const masterAudio = i === 0
      ? `\n        <asset-clip ref="${masterAssetRef}" lane="-1" offset="0s" name="${esc(baseName(master.path))}" start="${T(audioStartSec)}" duration="${T(audioDur)}"/>`
      : "";
    return (
      `      <mc-clip ref="${mediaId}" offset="${Tf(inF)}" name="${esc(name || group.id)}" start="${Tf(srcStartF)}" duration="${Tf(outF - inF)}">\n` +
      `        <mc-source angleID="${esc(sp.memberId)}" srcEnable="video"/>${masterAudio}\n` +
      `      </mc-clip>`
    );
  });

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<!DOCTYPE fcpxml>\n` +
    `<fcpxml version="${FCPXML_VERSION}">\n` +
    `  <resources>\n` +
    `    <format id="${formatId}" frameDuration="${fdStr}" width="${width}" height="${height}" colorSpace="1-1-1 (Rec. 709)"/>\n` +
    `${assetEls.join("\n")}\n` +
    `    <media id="${mediaId}" name="${esc(name || group.id)} multicam">\n` +
    `      <multicam format="${formatId}" tcStart="0s" tcFormat="NDF" duration="${T(mediaDuration)}">\n` +
    `${angleEls.join("\n")}\n` +
    `      </multicam>\n` +
    `    </media>\n` +
    `  </resources>\n` +
    `  <library>\n` +
    `    <event name="video-studio multicam">\n` +
    `      <project name="${esc(name || group.id)}">\n` +
    `        <sequence format="${formatId}" duration="${T(timelineLength)}" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">\n` +
    `          <spine>\n` +
    `${clipEls.join("\n")}\n` +
    `          </spine>\n` +
    `        </sequence>\n` +
    `      </project>\n` +
    `    </event>\n` +
    `  </library>\n` +
    `</fcpxml>\n`
  );
}
