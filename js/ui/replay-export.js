// ============================================================================
// Replay export — capture the arena canvas to a downloadable WebM video
// ============================================================================
//
// Plays the replay frames into the existing canvas at a fast rate and records
// the stream via MediaRecorder. Falls back to an animated PNG isn't viable
// in browsers, so for unsupported environments we surface a clear error.
// ============================================================================

const TARGET_FPS = 30;

/**
 * Run a replay export. Yields the next frame to draw via the `drawFrame`
 * callback every ~33ms until `frames` is exhausted. Returns a Blob.
 *
 *  drawFrame(frame, prevFrame, index, total) — synchronous canvas render
 *  canvas — the canvas to capture
 *  frames — array of replay frames
 *  bitrate — recording bitrate (default 2.5 Mbps)
 *  speed — playback multiplier (default 1.5x — keeps clips shareable)
 */
export async function exportReplay({ canvas, frames, drawFrame, speed = 1.5, bitrate = 2_500_000, onProgress = null }) {
  if (!canvas || typeof canvas.captureStream !== "function") {
    throw new Error("Canvas capture not supported in this browser.");
  }
  if (typeof window.MediaRecorder !== "function") {
    throw new Error("MediaRecorder not supported in this browser.");
  }
  if (!frames || frames.length === 0) {
    throw new Error("No replay frames to export.");
  }

  const stream = canvas.captureStream(TARGET_FPS);
  const mimeType = pickSupportedMime();
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond: bitrate } : { videoBitsPerSecond: bitrate });

  const chunks = [];
  recorder.addEventListener("dataavailable", (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  });
  const stopped = new Promise((resolve, reject) => {
    recorder.addEventListener("stop", () => resolve());
    recorder.addEventListener("error", (e) => reject(e?.error ?? new Error("MediaRecorder error")));
  });

  // Start recording, then drive the canvas through every frame at a fixed
  // wall-clock cadence so the captured video has a consistent framerate.
  recorder.start();

  try {
    const frameInterval = (1000 / TARGET_FPS) / Math.max(0.25, speed);
    let lastTimestamp = 0;
    for (let i = 0; i < frames.length; i++) {
      const prev = i > 0 ? frames[i - 1] : null;
      drawFrame(frames[i], prev, i, frames.length);
      if (typeof onProgress === "function") onProgress(i + 1, frames.length);
      if (lastTimestamp) {
        const now = performance.now();
        const elapsed = now - lastTimestamp;
        const wait = Math.max(0, frameInterval - elapsed);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      } else {
        await new Promise((r) => setTimeout(r, frameInterval));
      }
      lastTimestamp = performance.now();
    }

    // Allow one final frame to flush before stopping.
    await new Promise((r) => setTimeout(r, 100));
  } finally {
    if (recorder.state !== "inactive") {
      recorder.stop();
    }
  }

  await stopped;
  for (const track of stream.getTracks()) {
    track.stop();
  }

  const type = recorder.mimeType || "video/webm";
  return new Blob(chunks, { type });
}

function pickSupportedMime() {
  const candidates = [
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
    "video/mp4",
  ];
  for (const m of candidates) {
    if (window.MediaRecorder?.isTypeSupported?.(m)) return m;
  }
  return null;
}

export function extensionForMime(mime) {
  if (!mime) return "webm";
  if (mime.startsWith("video/mp4")) return "mp4";
  return "webm";
}
