export function createDiagnostics() {
  let fps = 0;
  let frames = 0;

  let lastFrameTs = 0;
  let latencyMs = 0;

  setInterval(() => {
    fps = frames;
    frames = 0;
  }, 1000);

  return {
    onFrame(ts: number) {
      frames++;
      if (lastFrameTs > 0) latencyMs = ts - lastFrameTs;
      lastFrameTs = ts;
      return { fps, latencyMs };
    },
    get() {
      return { fps, latencyMs };
    },
  };
}
