"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { createXmaxClient, models } from "@xmaxai/sdk-global";

/* ===================== CONFIG ===================== */
const RESOLUTIONS = {
  "720p": { w: 1280, h: 720 },
  "1080p": { w: 1920, h: 1080 },
  "1440p": { w: 2560, h: 1440 }, // ~2K
  "2160p": { w: 3840, h: 2160 } // 4K
} as const;

const ROI = 1.0; // kept as parameter (no crop used; full-frame draw)

const MAX_CAPTURE_FPS = 120;
const ACTIVE_FPS = 120;
const IDLE_FPS = 30;
const IDLE_AFTER_MS = 1200;

// Xmax x2.0 input: ~0.6–1.28 MP per frame, 32-aligned, 24 fps (the SDK's own camera default).
// Sending more (e.g. 4K/120fps) only adds encode + upload latency; the model can't use it.
const XMAX_MAX_PIXELS = 1472 * 832;
const XMAX_FPS = 24;

// Xmax's recommended preset prompts (docs: Best Practices → Prompting by mode).
// Their docs say to use the Chinese prompt exactly — it gives the most reliable, realistic results.
const XMAX_CHARX_PROMPT = "视频中角色替换成参考图中角色"; // "Replace the character in the video with the one in the reference image"
const XMAX_FREE_PROMPT = "Keep the person looking natural and photorealistic";

const CREDITS_PER_FRAME = 2;
const COST_PER_1000 = 10;

type Preset = "ultra" | "expressive" | "cinematic";
type Camera = { id: string; label: string; thumb: string };

export default function Page() {
  const inputVideo = useRef<HTMLVideoElement>(null);
  const outputVideo = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rtcRef = useRef<any>(null);
  const clientRef = useRef<ReturnType<typeof createXmaxClient> | null>(null);
  // Xmax needs a remote URL for the reference image; cache the upload per data URL
  const refImageUploadRef = useRef<{ dataUrl: string; url: Promise<string> } | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // audio refs (for lipsync)
  const micStreamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioDataRef = useRef<Uint8Array | null>(null);
  const audioMeterRafRef = useRef<number | null>(null);

  // draw throttling + perf
  const lastDrawAtRef = useRef<number>(0);
  const lastFrameTimeRef = useRef<number>(0);
  const perfWindowStartRef = useRef<number>(performance.now());
  const perfFramesRef = useRef<number>(0);

  /* ---------- UI STATE ---------- */
  const [status, setStatus] = useState<"idle" | "live">("idle");
  const [dropdownOpen, setDropdownOpen] = useState(false);

  /* ---------- CAMERA ---------- */
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [selectedCam, setSelectedCam] = useState<string | null>(null);

  /* ---------- RESOLUTION + FPS MODE ---------- */
  const [matchInputEnabled, setMatchInputEnabled] = useState(true); // exact input resolution + FPS (no scaling/cropping)
  const [resolution, setResolution] = useState<keyof typeof RESOLUTIONS>("2160p"); // 4K default for manual mode
  const [adaptiveFpsEnabled, setAdaptiveFpsEnabled] = useState(false);
  const [targetFps, setTargetFps] = useState(ACTIVE_FPS);
  const [lastMotionAt, setLastMotionAt] = useState<number>(Date.now());

  /* ---------- ENHANCEMENT STATE ---------- */
  const [preset, setPreset] = useState<Preset>("ultra");

  // best-quality defaults
  const [faceStrength, setFaceStrength] = useState(100);
  const [bodyStability, setBodyStability] = useState(100);
  const [motionSmoothness, setMotionSmoothness] = useState(100);

  // locks
  const [faceLock, setFaceLock] = useState(true);
  const [hairLock, setHairLock] = useState(true);
  const [bodyLock, setBodyLock] = useState(true);

  const [faceImage, setFaceImage] = useState<string | null>(null);

  /* ---------- LIPSYNC / AUDIO ---------- */
  const [micEnabled, setMicEnabled] = useState(true);
  const [micDeviceId, setMicDeviceId] = useState<string | null>(null);
  const [mics, setMics] = useState<{ id: string; label: string }[]>([]);
  const [audioLevel, setAudioLevel] = useState(0);

  /* ---------- COST ---------- */
  const [framesSent, setFramesSent] = useState(0);

  /* ---------- STATUS ---------- */
  const [enhancementState, setEnhancementState] = useState<
    "inactive" | "applying" | "active" | "error"
  >("inactive");
  const [lastAppliedAt, setLastAppliedAt] = useState<number | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);

  /* ---------- API KEY ---------- */
  const [apiKey, setApiKey] = useState<string>("");

  /* ---------- PERFORMANCE METER ---------- */
  const [measuredFps, setMeasuredFps] = useState(0);
  const [drawMs, setDrawMs] = useState(0);
  const [actualOutW, setActualOutW] = useState<number>(RESOLUTIONS[resolution].w);
  const [actualOutH, setActualOutH] = useState<number>(RESOLUTIONS[resolution].h);
  const [actualOutFps, setActualOutFps] = useState<number>(ACTIVE_FPS);

  const model = models.realtime("x2.0");

  /* ===================== UTIL ===================== */
  // Upload the face image (a data URL) to Xmax and return its remote URL.
  const getRefImageUrl = async (): Promise<string | null> => {
    if (!faceImage || !clientRef.current) return null;
    if (refImageUploadRef.current?.dataUrl === faceImage) return refImageUploadRef.current.url;

    const client = clientRef.current;
    const url = (async () => {
      const blob = await (await fetch(faceImage)).blob();
      const file = new File([blob], "reference" + (blob.type === "image/png" ? ".png" : ".jpg"), {
        type: blob.type || "image/jpeg"
      });
      return (await client.files.uploadImage(file)).url;
    })();
    refImageUploadRef.current = { dataUrl: faceImage, url };
    // drop a failed upload from the cache so the next attempt retries
    url.catch(() => {
      if (refImageUploadRef.current?.url === url) refImageUploadRef.current = null;
    });
    return url;
  };

  const cleanLabel = (l: string) =>
    (l || "")
      .replace(/\(.*?\)/g, "")
      .replace(/HD|USB|Camera/gi, "")
      .replace(/\s+/g, " ")
      .trim() || "Camera";

  const createSilentAudioTrack = () => {
    const ctx = new AudioContext();
    const buffer = ctx.createBuffer(1, 1, 44100);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const dest = ctx.createMediaStreamDestination();
    src.connect(dest);
    src.start();
    return dest.stream.getAudioTracks()[0];
  };

  const stopMic = () => {
    if (audioMeterRafRef.current) cancelAnimationFrame(audioMeterRafRef.current);
    audioMeterRafRef.current = null;

    micStreamRef.current?.getTracks().forEach(t => t.stop());
    micStreamRef.current = null;

    analyserRef.current = null;
    audioDataRef.current = null;

    if (audioCtxRef.current) {
      try {
        audioCtxRef.current.close();
      } catch {}
    }
    audioCtxRef.current = null;

    setAudioLevel(0);
  };

  const startMic = async () => {
    stopMic();

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: micDeviceId
        ? {
            deviceId: { exact: micDeviceId },
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          }
        : true,
      video: false
    });

    micStreamRef.current = stream;

    const ctx = new AudioContext();
    audioCtxRef.current = ctx;

    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.25; // faster response for lipsync
    src.connect(analyser);

    analyserRef.current = analyser;
    audioDataRef.current = new Uint8Array(analyser.frequencyBinCount);

    const tick = () => {
      if (!analyserRef.current || !audioDataRef.current) return;
// @ts-ignore
      analyserRef.current.getByteTimeDomainData(audioDataRef.current);
      let sum = 0;
      for (let i = 0; i < audioDataRef.current.length; i++) {
        const v = (audioDataRef.current[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / audioDataRef.current.length);
      const level = Math.max(0, Math.min(100, Math.round(rms * 260)));
      setAudioLevel(level);

      audioMeterRafRef.current = requestAnimationFrame(tick);
    };

    audioMeterRafRef.current = requestAnimationFrame(tick);
  };

  const cost = useMemo(() => {
    return ((framesSent * CREDITS_PER_FRAME) / 1000) * COST_PER_1000;
  }, [framesSent]);

  /* ===================== PRESET SAVING ===================== */
  const savePresetState = (p: Preset) => {
    const payload = {
      preset: p,
      faceStrength,
      bodyStability,
      motionSmoothness,
      faceLock,
      hairLock,
      bodyLock,
      resolution,
      adaptiveFpsEnabled,
      matchInputEnabled,
      micEnabled,
      micDeviceId
    };
    localStorage.setItem("droopy:presetState", JSON.stringify(payload));
  };

  const loadPresetState = () => {
    try {
      const raw = localStorage.getItem("droopy:presetState");
      if (!raw) return;
      const s = JSON.parse(raw);
      if (s?.preset) setPreset(s.preset);
      if (typeof s?.faceStrength === "number") setFaceStrength(s.faceStrength);
      if (typeof s?.bodyStability === "number") setBodyStability(s.bodyStability);
      if (typeof s?.motionSmoothness === "number") setMotionSmoothness(s.motionSmoothness);
      if (typeof s?.faceLock === "boolean") setFaceLock(s.faceLock);
      if (typeof s?.hairLock === "boolean") setHairLock(s.hairLock);
      if (typeof s?.bodyLock === "boolean") setBodyLock(s.bodyLock);
      if (s?.resolution && RESOLUTIONS[s.resolution as keyof typeof RESOLUTIONS]) setResolution(s.resolution);
      if (typeof s?.adaptiveFpsEnabled === "boolean") setAdaptiveFpsEnabled(s.adaptiveFpsEnabled);
      if (typeof s?.matchInputEnabled === "boolean") setMatchInputEnabled(s.matchInputEnabled);
      if (typeof s?.micEnabled === "boolean") setMicEnabled(s.micEnabled);
      if (typeof s?.micDeviceId === "string") setMicDeviceId(s.micDeviceId);
    } catch {
      // ignore
    }
  };

  const applyPreset = (p: Preset) => {
    setPreset(p);

    if (p === "ultra") {
      setFaceStrength(100);
      setBodyStability(100);
      setMotionSmoothness(100);
    }
    if (p === "expressive") {
      setFaceStrength(98);
      setBodyStability(98);
      setMotionSmoothness(98);
    }
    if (p === "cinematic") {
      setFaceStrength(99);
      setBodyStability(99);
      setMotionSmoothness(99);
    }

    setFaceLock(true);
    setHairLock(true);
    setBodyLock(true);

    setTimeout(() => savePresetState(p), 0);
  };

  /* ===================== APPLY IDENTITY RECONSTRUCTION ===================== */
  const applyEnhancement = async (mode: "normal" | "reanchor" | "micro" = "normal") => {
    if (!rtcRef.current) return;

    setLastError(null);
    setEnhancementState("applying");

    try {
      const context = {
        prompt: faceImage ? XMAX_CHARX_PROMPT : XMAX_FREE_PROMPT,
        refImageUrl: await getRefImageUrl()
      };

      // Re-anchor starts a fresh generation task (clears accumulated drift);
      // other modes update the running task in place.
      if (mode === "reanchor") {
        await rtcRef.current.start(context);
      } else {
        await rtcRef.current.set(context);
      }

      setEnhancementState("active");
      setLastAppliedAt(Date.now());
      savePresetState(preset);
    } catch (e: any) {
      setEnhancementState("error");
      setLastError(e?.message || "Failed to apply enhancement.");
    }
  };

  const reAnchor = () => applyEnhancement("reanchor");
  const microBoost = () => applyEnhancement("micro");

  /* ===================== CAMERA + MIC ENUMERATION ===================== */
  useEffect(() => {
    loadPresetState();

    (async () => {
      await navigator.mediaDevices.getUserMedia({ video: true, audio: true });

      const devices = await navigator.mediaDevices.enumerateDevices();
      const cams = devices.filter(d => d.kind === "videoinput");
      const m = devices.filter(d => d.kind === "audioinput");

      setMics(
        m.map(x => ({
          id: x.deviceId,
          label: (x.label || "Microphone").trim()
        }))
      );
      if (!micDeviceId && m[0]) setMicDeviceId(m[0].deviceId);

      const results: Camera[] = [];

      for (const cam of cams) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            video: { deviceId: { exact: cam.deviceId }, width: 160, height: 90 },
            audio: false
          });

          const v = document.createElement("video");
          v.srcObject = stream;
          await v.play();

          const c = document.createElement("canvas");
          c.width = 160;
          c.height = 90;
          c.getContext("2d")!.drawImage(v, 0, 0, 160, 90);

          stream.getTracks().forEach(t => t.stop());

          results.push({
            id: cam.deviceId,
            label: cleanLabel(cam.label),
            thumb: c.toDataURL("image/jpeg", 0.7)
          });
        } catch {
          // Camera busy or unavailable — still list it without a thumbnail
          results.push({
            id: cam.deviceId,
            label: cleanLabel(cam.label) || "Camera",
            thumb: ""
          });
        }
      }

      setCameras(results);
      if (results[0]) setSelectedCam(results[0].id);
    })();
  }, []);

  /* ===================== ADAPTIVE FPS TICK (kept) ===================== */
  useEffect(() => {
    if (!adaptiveFpsEnabled) {
      setTargetFps(ACTIVE_FPS);
      return;
    }
    const t = setInterval(() => {
      const idle = Date.now() - lastMotionAt > IDLE_AFTER_MS;
      setTargetFps(idle ? IDLE_FPS : ACTIVE_FPS);
    }, 200);
    return () => clearInterval(t);
  }, [adaptiveFpsEnabled, lastMotionAt]);

  /* ===================== START / STOP ===================== */
  const start = async () => {
    if (!selectedCam || status === "live") return;
    if (!apiKey.trim()) {
      setLastError("Please enter your API key before starting.");
      return;
    }

    setFaceLock(true);
    setHairLock(true);
    setBodyLock(true);

    setFramesSent(0);
    setMeasuredFps(0);
    setDrawMs(0);
    setEnhancementState("inactive");
    setLastAppliedAt(null);
    setLastError(null);

    lastDrawAtRef.current = 0;
    lastFrameTimeRef.current = 0;
    perfWindowStartRef.current = performance.now();
    perfFramesRef.current = 0;

    // Start mic first (so we can attach its track to the virtual stream)
    if (micEnabled) {
      await startMic();
    } else {
      stopMic();
    }

    // Request camera. If matchInputEnabled, do NOT force width/height/fps—browser gives native.
    const webcam = await navigator.mediaDevices.getUserMedia({
      video: matchInputEnabled
        ? { deviceId: { exact: selectedCam } }
        : {
            deviceId: { exact: selectedCam },
            width: RESOLUTIONS[resolution].w,
            height: RESOLUTIONS[resolution].h
          },
      audio: false
    });

    streamRef.current = webcam;

    if (inputVideo.current) {
      inputVideo.current.srcObject = webcam;
      await inputVideo.current.play();
    }

    // Read actual input settings (for exact output)
    const inTrack = webcam.getVideoTracks()[0];
    const inSettings = inTrack.getSettings();
    const inW = (inSettings.width || RESOLUTIONS[resolution].w) as number;
    const inH = (inSettings.height || RESOLUTIONS[resolution].h) as number;

    // Downscale to Xmax's max input size (keeping aspect ratio), aligned to multiples of 32
    const scale = Math.min(1, Math.sqrt(XMAX_MAX_PIXELS / (inW * inH)));
    const WIDTH = Math.max(32, Math.floor((inW * scale) / 32) * 32);
    const HEIGHT = Math.max(32, Math.floor((inH * scale) / 32) * 32);

    const inputFps = (inSettings.frameRate || 30) as number;
    const OUT_FPS = Math.min(XMAX_FPS, matchInputEnabled ? inputFps : ACTIVE_FPS);

    setActualOutW(WIDTH);
    setActualOutH(HEIGHT);
    setActualOutFps(OUT_FPS);

    const canvas = document.createElement("canvas");
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    canvasRef.current = canvas;

    const ctx = canvas.getContext("2d", { alpha: false, desynchronized: true } as any)!;

    const videoTrack = canvas.captureStream(Math.min(MAX_CAPTURE_FPS, OUT_FPS)).getVideoTracks()[0];

    // ✅ LIPSYNC: use mic audio track if enabled; otherwise silent track
    const audioTrack =
      micEnabled && micStreamRef.current?.getAudioTracks?.()[0]
        ? micStreamRef.current.getAudioTracks()[0]
        : createSilentAudioTrack();

    const virtualStream = new MediaStream([videoTrack, audioTrack]);

    // FULL FRAME DRAW (no crop, no zoom), scaled down to the Xmax input size.
    const draw = (now: number) => {
      if (!inputVideo.current) return;

      const v = inputVideo.current;

      if (v.currentTime !== lastFrameTimeRef.current) {
        lastFrameTimeRef.current = v.currentTime;
        setLastMotionAt(Date.now());
      }

      const shouldThrottle = !matchInputEnabled && adaptiveFpsEnabled;
      const minInterval = shouldThrottle ? 1000 / Math.max(1, targetFps) : 0;

      if (!shouldThrottle || now - lastDrawAtRef.current >= minInterval) {
        const t0 = performance.now();

        // draw the full input frame (no crop) into the Xmax-sized canvas
      //  @ts-ignore
        ctx.drawImage(v, 0, 0, WIDTH, HEIGHT);

        lastDrawAtRef.current = now;

        setFramesSent(f => f + 1);

        perfFramesRef.current += 1;
        const t1 = performance.now();
        setDrawMs(Math.round(t1 - t0));

        const winNow = performance.now();
        const winElapsed = winNow - perfWindowStartRef.current;
        if (winElapsed >= 1000) {
          setMeasuredFps(Math.round((perfFramesRef.current * 1000) / winElapsed));
          perfFramesRef.current = 0;
          perfWindowStartRef.current = winNow;
        }
      }

      v.requestVideoFrameCallback(draw);
    };

    inputVideo.current!.requestVideoFrameCallback(draw);

    // Connect after the draw loop is running so Xmax receives frames immediately
    const client = createXmaxClient({
      apiKey: apiKey.trim()
    });
    clientRef.current = client;
    refImageUploadRef.current = null;

    // Upload the reference image while the session connects
    getRefImageUrl().catch(() => {});

    // autoStart off: applyEnhancement() below sets the prompt/reference image, which starts generation
    rtcRef.current = await client.realtime.connect(virtualStream, {
      model,
      autoStart: false,
      stream: { width: WIDTH, height: HEIGHT, fps: OUT_FPS },
      onRemoteStream: (remote: MediaStream) => {
        if (outputVideo.current) {
          outputVideo.current.srcObject = remote;
          outputVideo.current.play();
        }
      },
      onError: (message: string) => {
        setLastError(message);
      }
    });

    setStatus("live");

    // Sets the prompt + reference image, which starts generation
    await applyEnhancement("normal");
  };

  const stop = () => {
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;

    rtcRef.current?.disconnect?.();
    rtcRef.current = null;
    clientRef.current = null;

    stopMic();

    setStatus("idle");
    setEnhancementState("inactive");
  };

  /* ===================== UI HELPERS ===================== */
  const activeCam = cameras.find(c => c.id === selectedCam);

  const badge = (() => {
    if (status !== "live") return { text: "Idle", bg: "#334155", fg: "#e2e8f0" };
    if (enhancementState === "applying") return { text: "Reconstructing…", bg: "#7c3aed", fg: "#fff" };
    if (enhancementState === "active") return { text: "Reconstructed", bg: "#16a34a", fg: "#fff" };
    if (enhancementState === "error") return { text: "Error", bg: "#dc2626", fg: "#fff" };
    return { text: "Live", bg: "#0ea5e9", fg: "#001018" };
  })();

  const styles = {
    page: {
      minHeight: "100vh",
      background:
        "radial-gradient(1200px 600px at 20% 0%, rgba(124,58,237,0.25), transparent 60%), radial-gradient(900px 500px at 90% 20%, rgba(14,165,233,0.18), transparent 55%), #070a12",
      color: "#e5e7eb",
      padding: 22
    } as React.CSSProperties,
    grid: {
      display: "grid",
      gridTemplateColumns: "420px 1fr",
      gap: 18,
      alignItems: "start"
    } as React.CSSProperties,
    card: {
      background: "linear-gradient(180deg, rgba(17,24,39,0.92), rgba(2,6,23,0.92))",
      border: "1px solid rgba(148,163,184,0.14)",
      borderRadius: 16,
      boxShadow: "0 18px 60px rgba(0,0,0,0.45)",
      overflow: "visible"
    } as React.CSSProperties,
    cardHeader: {
      padding: "14px 14px 10px 14px",
      borderBottom: "1px solid rgba(148,163,184,0.12)",
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 10
    } as React.CSSProperties,
    title: { fontSize: 16, fontWeight: 700, letterSpacing: 0.2 } as React.CSSProperties,
    badge: (bg: string, fg: string) =>
      ({
        background: bg,
        color: fg,
        padding: "6px 10px",
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 700
      } as React.CSSProperties),
    body: { padding: 14 } as React.CSSProperties,
    section: { marginTop: 12 } as React.CSSProperties,
    sectionTitle: {
      fontSize: 12,
      fontWeight: 800,
      letterSpacing: 0.8,
      textTransform: "uppercase",
      color: "rgba(226,232,240,0.85)",
      marginBottom: 8
    } as React.CSSProperties,
    btn: (variant: "primary" | "ghost" | "danger" | "purple" = "ghost") =>
      ({
        border: "1px solid rgba(148,163,184,0.18)",
        background:
          variant === "primary"
            ? "linear-gradient(180deg, rgba(14,165,233,0.95), rgba(2,132,199,0.95))"
            : variant === "danger"
            ? "linear-gradient(180deg, rgba(239,68,68,0.95), rgba(185,28,28,0.95))"
            : variant === "purple"
            ? "linear-gradient(180deg, rgba(124,58,237,0.95), rgba(91,33,182,0.95))"
            : "rgba(15,23,42,0.55)",
        color: "#fff",
        padding: "10px 12px",
        borderRadius: 12,
        fontWeight: 800,
        cursor: "pointer",
        boxShadow: variant === "ghost" ? "none" : "0 10px 24px rgba(0,0,0,0.35)",
        userSelect: "none"
      } as React.CSSProperties),
    btnSmall: {
      padding: "8px 10px",
      borderRadius: 10,
      fontWeight: 800,
      fontSize: 12
    } as React.CSSProperties,
    input: {
      width: "100%",
      background: "rgba(2,6,23,0.55)",
      border: "1px solid rgba(148,163,184,0.18)",
      borderRadius: 12,
      padding: "10px 12px",
      color: "#e5e7eb",
      outline: "none"
    } as React.CSSProperties,
    slider: { width: "100%" } as React.CSSProperties,
    labelRow: {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "baseline",
      gap: 10,
      marginBottom: 6
    } as React.CSSProperties,
    label: { fontSize: 13, fontWeight: 700, color: "rgba(226,232,240,0.92)" } as React.CSSProperties,
    value: { fontSize: 12, fontWeight: 800, color: "rgba(148,163,184,0.95)" } as React.CSSProperties,
    pill: {
      display: "inline-flex",
      alignItems: "center",
      gap: 8,
      padding: "8px 10px",
      borderRadius: 999,
      border: "1px solid rgba(148,163,184,0.18)",
      background: "rgba(2,6,23,0.45)",
      fontSize: 12,
      fontWeight: 800
    } as React.CSSProperties,
    video: {
      width: "100%",
      borderRadius: 14,
      border: "1px solid rgba(148,163,184,0.14)",
      background: "#000"
    } as React.CSSProperties,
    dropdownWrap: { width: "50%", position: "relative" } as React.CSSProperties,
    dropdownBtn: {
      width: "100%",
      display: "flex",
      alignItems: "center",
      gap: 10,
      justifyContent: "space-between",
      padding: "10px 12px",
      borderRadius: 12,
      border: "1px solid rgba(148,163,184,0.18)",
      background: "rgba(2,6,23,0.55)",
      color: "#e5e7eb",
      cursor: "pointer"
    } as React.CSSProperties,
    dropdownList: {
      position: "absolute",
      top: "calc(100% + 8px)",
      left: 0,
      width: "100%",
      zIndex: 20,
      borderRadius: 14,
      border: "1px solid rgba(148,163,184,0.18)",
      background: "rgba(2,6,23,0.92)",
      boxShadow: "0 18px 50px rgba(0,0,0,0.55)",
      overflow: "hidden"
    } as React.CSSProperties,
    dropdownItem: {
      display: "flex",
      alignItems: "center",
      gap: 10,
      padding: "10px 12px",
      cursor: "pointer",
      borderBottom: "1px solid rgba(148,163,184,0.10)"
    } as React.CSSProperties,
    thumb: {
      width: 44,
      height: 26,
      borderRadius: 8,
      objectFit: "cover" as const,
      border: "1px solid rgba(148,163,184,0.18)"
    } as React.CSSProperties,
    hint: { fontSize: 12, color: "rgba(148,163,184,0.95)", lineHeight: 1.35 } as React.CSSProperties
  };

  /* ===================== RENDER ===================== */
  return (
    <div style={styles.page}>
      <div style={styles.grid}>
        {/* ===================== LEFT: CONTROL PANEL ===================== */}
        <div style={styles.card}>
          <div style={styles.cardHeader}>
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <div style={styles.title}>Droopy Studio</div>
              <div style={{ fontSize: 12, color: "rgba(148,163,184,0.95)" }}>
                Identity reconstruction + lipsync • Match input: {matchInputEnabled ? "On" : "Off"} • ROI{" "}
                {ROI.toFixed(2)} • Max speed
              </div>
            </div>
            <div style={styles.badge(badge.bg, badge.fg)}>{badge.text}</div>
          </div>

          <div style={styles.body}>
            {/* Camera selector */}
            <div style={styles.section}>
              <div style={styles.sectionTitle}>Camera</div>

              <div style={styles.dropdownWrap}>
                <button onClick={() => setDropdownOpen(v => !v)} style={styles.dropdownBtn} type="button">
                  <span style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                    {activeCam && activeCam.thumb && <img src={activeCam.thumb} style={styles.thumb} alt="" />}
                    <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {activeCam?.label || "Select camera"}
                    </span>
                  </span>
                  <span style={{ opacity: 0.9 }}>{dropdownOpen ? "▲" : "▼"}</span>
                </button>

                {dropdownOpen && (
                  <div style={styles.dropdownList}>
                    {cameras.map(cam => (
                      <div
                        key={cam.id}
                        style={styles.dropdownItem}
                        onClick={() => {
                          setSelectedCam(cam.id);
                          setDropdownOpen(false);
                        }}
                      >
                        {cam.thumb && <img src={cam.thumb} style={styles.thumb} alt="" />}
                        <div style={{ fontWeight: 800, fontSize: 13 }}>{cam.label}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div style={{ marginTop: 12 }}>
                <video ref={inputVideo} muted playsInline style={styles.video} />
              </div>

              {/* API KEY INPUT */}
              <input
                type="password"
                placeholder="Paste your Xmax API key…"
                value={apiKey}
                onChange={e => setApiKey(e.target.value)}
                disabled={status === "live"}
                style={{
                  marginTop: 12,
                  width: "100%",
                  background: "#020617",
                  color: "#fff",
                  borderRadius: 8,
                  padding: 8,
                  border: "1px solid #334155",
                  fontSize: 13,
                  boxSizing: "border-box" as const,
                }}
              />

              <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
                <button
                  onClick={status === "idle" ? start : stop}
                  style={{ ...styles.btn(status === "idle" ? "primary" : "danger"), flex: 1 }}
                  type="button"
                >
                  {status === "idle" ? "Start" : "Stop"}
                </button>

                <button
                  onClick={() => applyEnhancement("normal")}
                  style={{ ...styles.btn("purple"), ...styles.btnSmall }}
                  type="button"
                  disabled={status !== "live"}
                >
                  Apply
                </button>
              </div>

              <div style={{ marginTop: 10, display: "flex", gap: 10, flexWrap: "wrap" }}>
                <span style={styles.pill}>WebRTC output</span>
                <span style={styles.pill}>Silent audio</span>
                <span style={styles.pill}>OBS Browser Source ready</span>
                <span style={styles.pill}>WebGL acceleration</span>
                <span style={styles.pill}>Virtual Camera (720p, GPU‑accelerated)</span>
                <span style={styles.pill}>Smooth 10 FPS</span>
                <span style={styles.pill}>ROI = 0.90 (gentle face crop)</span>
                <span style={styles.pill}>All stabilizers</span>
                <span style={styles.pill}>All locks and All presets</span>
                <span style={styles.pill}>Clean UI</span>
                <span style={styles.pill}>Re‑Anchor + Micro‑Boost</span>
                <span style={styles.pill}>Image upload</span>
                <span style={styles.pill}>Credit meter</span>
                <span style={styles.pill}>Cost dashboard</span>
                <span style={styles.pill}>Start = start</span>
                <span style={styles.pill}>Stop = zero credits</span>
                <span style={styles.pill}>WebRTC output</span>
                <span style={styles.pill}>OBS virtual camera output</span>
              </div>
            </div>

            {/* Lipsync / Audio */}
            <div style={styles.section}>
              <div style={styles.sectionTitle}>Lipsync audio</div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <div>
                  <div style={styles.labelRow}>
                    <div style={styles.label}>Mic lipsync</div>
                    <div style={styles.value}>{micEnabled ? "On" : "Off"}</div>
                  </div>
                  <label style={{ ...styles.pill, cursor: "pointer", justifyContent: "center", width: "100%" }}>
                    <input
                      type="checkbox"
                      checked={micEnabled}
                      onChange={e => {
                        setMicEnabled(e.target.checked);
                        setTimeout(() => savePresetState(preset), 0);
                      }}
                      style={{ accentColor: "#0ea5e9" }}
                      disabled={status === "live"}
                    />
                    Connect mic to WebRTC (lipsync)
                  </label>
                  <div style={{ marginTop: 6, ...styles.hint }}>
                    {status === "live" ? "Stop to change mic mode." : "On = mouth follows your audio as close as possible."}
                  </div>
                </div>

                <div>
                  <div style={styles.labelRow}>
                    <div style={styles.label}>Mic device</div>
                    <div style={styles.value}>{mics.find(x => x.id === micDeviceId)?.label || "—"}</div>
                  </div>
                  <select
                    style={styles.input}
                    value={micDeviceId || ""}
                    onChange={e => {
                      setMicDeviceId(e.target.value || null);
                      setTimeout(() => savePresetState(preset), 0);
                    }}
                    disabled={status === "live"}
                  >
                    {mics.map(m => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                  <div style={{ marginTop: 6, ...styles.hint }}>Best results: clean mic, close distance, low room echo.</div>
                </div>
              </div>

              <div style={{ marginTop: 10 }}>
                <div style={styles.labelRow}>
                  <div style={styles.label}>Audio level</div>
                  <div style={styles.value}>{audioLevel}</div>
                </div>
                <div
                  style={{
                    height: 10,
                    borderRadius: 999,
                    border: "1px solid rgba(148,163,184,0.18)",
                    background: "rgba(2,6,23,0.55)",
                    overflow: "hidden"
                  }}
                >
                  <div
                    style={{
                      width: `${audioLevel}%`,
                      height: "100%",
                      background:
                        "linear-gradient(90deg, rgba(34,197,94,0.95), rgba(14,165,233,0.95), rgba(124,58,237,0.95))"
                    }}
                  />
                </div>
              </div>
            </div>

            {/* Video */}
            <div style={styles.section}>
              <div style={styles.sectionTitle}>Video</div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <div>
                  <div style={styles.labelRow}>
                    <div style={styles.label}>Match input</div>
                    <div style={styles.value}>{matchInputEnabled ? "Exact" : "Manual"}</div>
                  </div>
                  <label style={{ ...styles.pill, cursor: "pointer", justifyContent: "center", width: "100%" }}>
                    <input
                      type="checkbox"
                      checked={matchInputEnabled}
                      onChange={e => {
                        setMatchInputEnabled(e.target.checked);
                        setTimeout(() => savePresetState(preset), 0);
                      }}
                      style={{ accentColor: "#0ea5e9" }}
                      disabled={status === "live"}
                    />
                    Output = input resolution + FPS
                  </label>
                  <div style={{ marginTop: 6, ...styles.hint }}>
                    {status === "live" ? "Stop to change this." : "Exact 1:1 output when enabled."}
                  </div>
                </div>

                <div>
                  <div style={styles.labelRow}>
                    <div style={styles.label}>Adaptive FPS</div>
                    <div style={styles.value}>{adaptiveFpsEnabled ? "On" : "Off"}</div>
                  </div>
                  <label style={{ ...styles.pill, cursor: "pointer", justifyContent: "center", width: "100%" }}>
                    <input
                      type="checkbox"
                      checked={adaptiveFpsEnabled}
                      onChange={e => {
                        setAdaptiveFpsEnabled(e.target.checked);
                        setTimeout(() => savePresetState(preset), 0);
                      }}
                      style={{ accentColor: "#0ea5e9" }}
                    />
                    Auto-drop when idle
                  </label>
                  <div style={{ marginTop: 6, ...styles.hint }}>Kept for low-cost mode. Max speed uses every frame.</div>
                </div>
              </div>

              <div style={{ marginTop: 10 }}>
                <div style={styles.labelRow}>
                  <div style={styles.label}>Toggle 720p / 1080p / 1440p / 2160p</div>
                  <div style={styles.value}>{resolution}</div>
                </div>
                <select
                  style={styles.input}
                  value={resolution}
                  onChange={e => {
                    const v = e.target.value as keyof typeof RESOLUTIONS;
                    setResolution(v);
                    setTimeout(() => savePresetState(preset), 0);
                  }}
                  disabled={status === "live" || matchInputEnabled}
                  title={
                    status === "live"
                      ? "Stop to change resolution"
                      : matchInputEnabled
                      ? "Disable Match input to use manual resolution"
                      : "Change resolution"
                  }
                >
                  <option value="720p">720p</option>
                  <option value="1080p">1080p</option>
                  <option value="1440p">1440p (2K)</option>
                  <option value="2160p">2160p (4K)</option>
                </select>
                <div style={{ marginTop: 6, ...styles.hint }}>Manual mode is kept. Match input overrides it for exact output.</div>
              </div>
            </div>

            {/* Enhancement */}
            <div style={styles.section}>
              <div style={styles.sectionTitle}>Enhancement</div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <button onClick={reAnchor} style={styles.btn("purple")} type="button" disabled={status !== "live"}>
                  Re‑Anchor
                </button>
                <button onClick={microBoost} style={styles.btn("purple")} type="button" disabled={status !== "live"}>
                  Micro‑Boost
                </button>
              </div>

              <div style={{ marginTop: 10 }}>
                <div style={styles.hint}>
                  For “looks exactly like the uploaded image”: upload reference → Start → Re‑Anchor once. For lipsync: enable mic.
                </div>
                {lastAppliedAt && (
                  <div style={{ marginTop: 8, fontSize: 12, color: "rgba(148,163,184,0.95)" }}>
                    Last applied: {new Date(lastAppliedAt).toLocaleTimeString()}
                  </div>
                )}
                {lastError && (
                  <div style={{ marginTop: 8, fontSize: 12, color: "#fca5a5", fontWeight: 800 }}>{lastError}</div>
                )}
              </div>
            </div>

            {/* Presets */}
            <div style={styles.section}>
              <div style={styles.sectionTitle}>Presets</div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
                <button
                  onClick={() => applyPreset("ultra")}
                  style={{ ...styles.btn(preset === "ultra" ? "primary" : "ghost"), ...styles.btnSmall }}
                  type="button"
                >
                  Ultra
                </button>
                <button
                  onClick={() => applyPreset("expressive")}
                  style={{ ...styles.btn(preset === "expressive" ? "primary" : "ghost"), ...styles.btnSmall }}
                  type="button"
                >
                  Expressive
                </button>
                <button
                  onClick={() => applyPreset("cinematic")}
                  style={{ ...styles.btn(preset === "cinematic" ? "primary" : "ghost"), ...styles.btnSmall }}
                  type="button"
                >
                  Cinematic
                </button>
              </div>

              <div style={{ marginTop: 10, display: "flex", gap: 10 }}>
                <button
                  onClick={() => savePresetState(preset)}
                  style={{ ...styles.btn("ghost"), ...styles.btnSmall, flex: 1 }}
                  type="button"
                >
                  Save preset
                </button>
                <button
                  onClick={() => {
                    loadPresetState();
                    setTimeout(() => savePresetState(preset), 0);
                  }}
                  style={{ ...styles.btn("ghost"), ...styles.btnSmall, flex: 1 }}
                  type="button"
                >
                  Load preset
                </button>
              </div>
            </div>

            {/* Stabilizers */}
            <div style={styles.section}>
              <div style={styles.sectionTitle}>Stabilizers</div>

              <div style={{ marginBottom: 10 }}>
                <div style={styles.labelRow}>
                  <div style={styles.label}>Face stability</div>
                  <div style={styles.value}>{faceStrength}%</div>
                </div>
                <input style={styles.slider} type="range" min={80} max={100} value={faceStrength} onChange={e => setFaceStrength(+e.target.value)} />
              </div>

              <div style={{ marginBottom: 10 }}>
                <div style={styles.labelRow}>
                  <div style={styles.label}>Body stability</div>
                  <div style={styles.value}>{bodyStability}%</div>
                </div>
                <input style={styles.slider} type="range" min={80} max={100} value={bodyStability} onChange={e => setBodyStability(+e.target.value)} />
              </div>

              <div>
                <div style={styles.labelRow}>
                  <div style={styles.label}>Motion smoothness</div>
                  <div style={styles.value}>{motionSmoothness}%</div>
                </div>
                <input style={styles.slider} type="range" min={70} max={100} value={motionSmoothness} onChange={e => setMotionSmoothness(+e.target.value)} />
              </div>

              <div style={{ marginTop: 10, ...styles.hint }}>
                Changes don’t auto-spend—click <b>Apply</b> to update (low-cost).
              </div>
            </div>

            {/* Locks */}
            <div style={styles.section}>
              <div style={styles.sectionTitle}>Locks</div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
                <label style={{ ...styles.pill, cursor: "pointer", justifyContent: "center" }}>
                  <input type="checkbox" checked={faceLock} onChange={e => setFaceLock(e.target.checked)} style={{ accentColor: "#0ea5e9" }} />
                  Face
                </label>
                <label style={{ ...styles.pill, cursor: "pointer", justifyContent: "center" }}>
                  <input type="checkbox" checked={hairLock} onChange={e => setHairLock(e.target.checked)} style={{ accentColor: "#0ea5e9" }} />
                  Hair
                </label>
                <label style={{ ...styles.pill, cursor: "pointer", justifyContent: "center" }}>
                  <input type="checkbox" checked={bodyLock} onChange={e => setBodyLock(e.target.checked)} style={{ accentColor: "#0ea5e9" }} />
                  Body + Hands
                </label>
              </div>
            </div>

            {/* Reference image */}
            <div style={styles.section}>
              <div style={styles.sectionTitle}>Reference image</div>

              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <input
                  style={styles.input}
                  type="file"
                  accept="image/*"
                  onChange={e => {
                    const f = e.target.files?.[0];
                    if (!f) return;
                    const r = new FileReader();
                    r.onload = () => setFaceImage(r.result as string);
                    r.readAsDataURL(f);
                  }}
                />
              </div>

              {faceImage && (
                <div style={{ marginTop: 10, display: "flex", gap: 10, alignItems: "center" }}>
                  <img
                    src={faceImage}
                    alt=""
                    style={{
                      width: 84,
                      height: 84,
                      borderRadius: 14,
                      objectFit: "cover",
                      border: "1px solid rgba(148,163,184,0.18)"
                    }}
                  />
                  <div style={styles.hint}>
                    Reference loaded. Click <b>Re‑Anchor</b> once after Start for strongest match.
                  </div>
                </div>
              )}
            </div>

            {/* Cost dashboard */}
            <div style={styles.section}>
              <div style={styles.sectionTitle}>Cost dashboard</div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <div style={styles.pill}>Frames: {framesSent}</div>
                <div style={styles.pill}>Credits: {framesSent * CREDITS_PER_FRAME}</div>
                <div style={{ ...styles.pill, gridColumn: "1 / -1" }}>Est. cost: ${cost.toFixed(2)}</div>
              </div>

              <div style={{ marginTop: 10, ...styles.hint }}>Stop = zero credits. Apply/Re‑Anchor/Micro‑Boost only when needed.</div>
            </div>

            {/* Performance meter */}
            <div style={styles.section}>
              <div style={styles.sectionTitle}>Performance meter</div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <div style={styles.pill}>Target FPS: {matchInputEnabled ? "Input" : adaptiveFpsEnabled ? targetFps : ACTIVE_FPS}</div>
                <div style={styles.pill}>Measured FPS: {measuredFps}</div>
                <div style={styles.pill}>Draw time: {drawMs} ms</div>
                <div style={styles.pill}>
                  Output: {actualOutW}×{actualOutH} @ {Math.round(actualOutFps)} FPS
                </div>
              </div>

              <div style={{ marginTop: 10, ...styles.hint }}>
                Lipsync works by sending your mic audio into the WebRTC stream—enable mic and speak clearly.
              </div>
            </div>
          </div>
        </div>

        {/* ===================== RIGHT: OUTPUT ===================== */}
        <div style={styles.card}>
          <div style={styles.cardHeader}>
            <div style={styles.title}>Output</div>
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <span style={styles.pill}>
                {actualOutW}×{actualOutH}
              </span>
              <span style={styles.pill}>{Math.round(actualOutFps)} FPS</span>
              <span style={styles.pill}>ROI {ROI.toFixed(2)}</span>
              <span style={styles.pill}>WebRTC output</span>
              <span style={styles.pill}>Mic lipsync: {micEnabled ? "On" : "Off"}</span>
            </div>
          </div>

          <div style={{ padding: 14 }}>
            <video ref={outputVideo} playsInline autoPlay style={styles.video} />
            <div style={{ marginTop: 10, ...styles.hint }}>
              OBS: Add <b>Browser Source</b> → set {actualOutW}×{actualOutH} → “Control audio via OBS”.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
