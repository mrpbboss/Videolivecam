"use client";

import React, { useEffect, useRef, useState } from "react";

/*
 * Live voice changer using the ElevenLabs Voice Changer (speech-to-speech) API.
 *
 * ElevenLabs converts audio clips, not a live stream, so we:
 *   mic -> detect each spoken phrase (cut on a short pause) -> POST it as 16 kHz PCM
 *   -> stream the converted voice back as PCM -> play it on the chosen output device.
 * The changed voice therefore follows each phrase by roughly 1-2 seconds.
 *
 * Pick "CABLE Input (VB-Audio Virtual Cable)" as the output, then use
 * "CABLE Output" as the microphone in OBS.
 */

const API = "https://api.elevenlabs.io/v1";
const MODEL_ID = "eleven_multilingual_sts_v2";
const IN_RATE = 16000; // ElevenLabs low-latency input format: pcm_s16le_16 (16 kHz mono)
const OUT_RATE = 24000; // requested output format: pcm_24000
const FRAME_MS = 20;
const PRE_ROLL_MS = 250; // audio kept from just before speech starts, so first syllables aren't clipped
const MAX_PHRASE_MS = 8000; // force a cut on long run-on speech
const MIN_PHRASE_MS = 300; // ignore clicks and very short noises

const LS_KEY = "droopy:voiceChanger";

type Voice = { voice_id: string; name: string; category?: string };
type Device = { id: string; label: string };
type Styles = Record<string, any>;

// Captures raw mic samples off the audio thread and posts them to the page
const WORKLET_SRC = `
class Tap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor("vc-tap", Tap);
`;

const loadSaved = () => {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || "{}");
  } catch {
    return {};
  }
};

const save = (patch: Record<string, unknown>) => {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ ...loadSaved(), ...patch }));
  } catch {}
};

// Linear-interpolation resample of mono float audio
const resample = (input: Float32Array, from: number, to: number) => {
  if (from === to) return input;
  const outLen = Math.floor((input.length * to) / from);
  const out = new Float32Array(outLen);
  const ratio = from / to;
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const t = pos - i0;
    out[i] = input[i0] * (1 - t) + input[i1] * t;
  }
  return out;
};

const toPcm16 = (f32: Float32Array) => {
  const buf = new ArrayBuffer(f32.length * 2);
  const view = new DataView(buf);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
};

const concat = (chunks: Float32Array[]) => {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Float32Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
};

const apiError = async (res: Response) => {
  let detail = "";
  let status = "";
  try {
    const j = await res.json();
    status = typeof j?.detail?.status === "string" ? j.detail.status : "";
    detail = j?.detail?.message || status || (typeof j?.detail === "string" ? j.detail : "");
  } catch {}
  // ElevenLabs uses 401 for several problems; name the common ones
  if (res.status === 401) {
    if (status === "missing_permissions" || /permission/i.test(detail))
      return `This API key is missing a permission (${detail || status}). Edit the key on elevenlabs.io: set "Speech to Speech" to Access and "Voices" to Write.`;
    if (status === "quota_exceeded" || /quota|credits/i.test(detail))
      return `Out of ElevenLabs credits, or the key's credit limit was reached (${detail || status}).`;
    return `ElevenLabs rejected the API key${detail ? `: ${detail}` : ""}. Check it was copied in full.`;
  }
  return `ElevenLabs error ${res.status}${detail ? `: ${detail}` : ""}`;
};

export default function VoiceChanger({ styles }: { styles: Styles }) {
  const [loaded, setLoaded] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [voices, setVoices] = useState<Voice[]>([]);
  const [voiceId, setVoiceId] = useState("");
  const [inputs, setInputs] = useState<Device[]>([]);
  const [outputs, setOutputs] = useState<Device[]>([]);
  const [inputId, setInputId] = useState("");
  const [outputId, setOutputId] = useState("");
  const [sensitivity, setSensitivity] = useState(60);
  const [pauseMs, setPauseMs] = useState(450);
  const [removeNoise, setRemoveNoise] = useState(false);

  const [running, setRunning] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [phrases, setPhrases] = useState(0);
  const [lastLatency, setLastLatency] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  // clone form
  const [cloneName, setCloneName] = useState("My voice");
  const [cloneFiles, setCloneFiles] = useState<File[]>([]);
  const [cloning, setCloning] = useState(false);

  const micRef = useRef<MediaStream | null>(null);
  const inCtxRef = useRef<AudioContext | null>(null);
  const outCtxRef = useRef<AudioContext | null>(null);
  const playheadRef = useRef(0);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const runningRef = useRef(false);

  // live settings read from the audio callback without restarting capture
  const settingsRef = useRef({ sensitivity, pauseMs, removeNoise, voiceId, apiKey });
  settingsRef.current = { sensitivity, pauseMs, removeNoise, voiceId, apiKey };

  /* ---------- devices ---------- */
  const loadDevices = async () => {
    let devs = await navigator.mediaDevices.enumerateDevices();
    // Device names/ids stay hidden until mic permission is granted
    if (devs.some(d => d.kind === "audioinput" && !d.label)) {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: true });
        s.getTracks().forEach(t => t.stop());
        devs = await navigator.mediaDevices.enumerateDevices();
      } catch {}
    }
    const ins = devs.filter(d => d.kind === "audioinput").map(d => ({ id: d.deviceId, label: d.label || "Microphone" }));
    const outs = devs.filter(d => d.kind === "audiooutput").map(d => ({ id: d.deviceId, label: d.label || "Speaker" }));
    setInputs(ins);
    setOutputs(outs);
    // default to the real mic and to VB-Cable, unless a saved device is still present
    setInputId(cur => {
      if (cur && ins.some(d => d.id === cur)) return cur;
      return (ins.find(d => !/voicemod|cable|droidcam/i.test(d.label)) || ins[0])?.id || "";
    });
    setOutputId(cur => {
      if (cur && outs.some(d => d.id === cur)) return cur;
      return (outs.find(d => /cable input/i.test(d.label)) || outs.find(d => d.id === "default") || outs[0])?.id || "";
    });
  };

  // Restore saved settings after mount (localStorage isn't available during server render)
  useEffect(() => {
    const saved = loadSaved();
    if (saved.apiKey) setApiKey(saved.apiKey);
    if (saved.voiceId) setVoiceId(saved.voiceId);
    if (saved.inputId) setInputId(saved.inputId);
    if (saved.outputId) setOutputId(saved.outputId);
    if (typeof saved.sensitivity === "number") setSensitivity(saved.sensitivity);
    if (typeof saved.pauseMs === "number") setPauseMs(saved.pauseMs);
    if (typeof saved.removeNoise === "boolean") setRemoveNoise(saved.removeNoise);
    setLoaded(true);
    if (saved.apiKey) loadVoices(saved.apiKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    loadDevices().catch(() => {});
    navigator.mediaDevices.addEventListener?.("devicechange", loadDevices);
    return () => navigator.mediaDevices.removeEventListener?.("devicechange", loadDevices);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------- voices ---------- */
  const loadVoices = async (key = apiKey) => {
    if (!key.trim()) return;
    setError(null);
    try {
      const res = await fetch(`${API}/voices`, { headers: { "xi-api-key": key.trim() } });
      if (!res.ok) throw new Error(await apiError(res));
      const j = await res.json();
      const list: Voice[] = (j.voices || []).map((v: any) => ({ voice_id: v.voice_id, name: v.name, category: v.category }));
      // your own clones first
      list.sort((a, b) => Number(b.category === "cloned") - Number(a.category === "cloned") || a.name.localeCompare(b.name));
      setVoices(list);
      if (!list.some(v => v.voice_id === settingsRef.current.voiceId) && list[0]) setVoiceId(list[0].voice_id);
    } catch (e: any) {
      setError(e?.message || "Could not load voices.");
    }
  };

  useEffect(() => {
    if (!loaded) return; // don't overwrite saved settings with defaults
    save({ apiKey, voiceId, inputId, outputId, sensitivity, pauseMs, removeNoise });
  }, [loaded, apiKey, voiceId, inputId, outputId, sensitivity, pauseMs, removeNoise]);

  /* ---------- clone ---------- */
  const cloneVoice = async () => {
    if (!apiKey.trim() || !cloneFiles.length) return;
    setCloning(true);
    setError(null);
    setInfo(null);
    try {
      const form = new FormData();
      form.append("name", cloneName.trim() || "My voice");
      cloneFiles.forEach(f => form.append("files", f, f.name));
      form.append("remove_background_noise", "true");
      const res = await fetch(`${API}/voices/add`, {
        method: "POST",
        headers: { "xi-api-key": apiKey.trim() },
        body: form
      });
      if (!res.ok) throw new Error(await apiError(res));
      const { voice_id } = await res.json();
      await loadVoices();
      setVoiceId(voice_id);
      setCloneFiles([]);
      setInfo(`Cloned "${cloneName}" and selected it.`);
    } catch (e: any) {
      setError(e?.message || "Cloning failed.");
    } finally {
      setCloning(false);
    }
  };

  /* ---------- playback ---------- */
  const playPcm = (int16: Int16Array) => {
    const ctx = outCtxRef.current;
    if (!ctx || !int16.length) return;
    const f32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) f32[i] = int16[i] / 0x8000;
    const buf = ctx.createBuffer(1, f32.length, OUT_RATE);
    buf.copyToChannel(f32, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    const startAt = Math.max(ctx.currentTime + 0.02, playheadRef.current);
    src.start(startAt);
    playheadRef.current = startAt + buf.duration;
  };

  /* ---------- convert one phrase ---------- */
  const convertPhrase = async (pcm16k: Float32Array, endedAt: number) => {
    const { apiKey: key, voiceId: vid, removeNoise: rn } = settingsRef.current;
    if (!runningRef.current || !key || !vid) return;

    setBusy(true);
    try {
      const form = new FormData();
      form.append("audio", new Blob([toPcm16(pcm16k)], { type: "application/octet-stream" }), "phrase.pcm");
      form.append("file_format", "pcm_s16le_16");
      form.append("model_id", MODEL_ID);
      form.append("remove_background_noise", String(rn));

      const res = await fetch(`${API}/speech-to-speech/${vid}/stream?output_format=pcm_${OUT_RATE}`, {
        method: "POST",
        headers: { "xi-api-key": key.trim() },
        body: form
      });
      if (!res.ok || !res.body) throw new Error(await apiError(res));

      // Stream the PCM back and play as it arrives (carry odd bytes between chunks)
      const reader = res.body.getReader();
      let carry: Uint8Array | null = null;
      let first = true;
      for (;;) {
        const { done, value } = await reader.read();
        if (done || !runningRef.current) break;
        let bytes = value;
        if (carry) {
          const merged = new Uint8Array(carry.length + bytes.length);
          merged.set(carry);
          merged.set(bytes, carry.length);
          bytes = merged;
          carry = null;
        }
        const even = bytes.length - (bytes.length % 2);
        if (even < bytes.length) carry = bytes.slice(even);
        if (!even) continue;
        if (first) {
          setLastLatency(Math.round(performance.now() - endedAt));
          first = false;
        }
        playPcm(new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + even)));
      }
      setPhrases(n => n + 1);
      setError(null);
    } catch (e: any) {
      setError(e?.message || "Voice conversion failed.");
    } finally {
      setBusy(false);
    }
  };

  /* ---------- start / stop ---------- */
  const start = async () => {
    if (running) return;
    setError(null);
    setInfo(null);
    if (!apiKey.trim()) return setError("Enter your ElevenLabs API key.");
    if (!voiceId) return setError("Pick a voice (or clone one) first.");

    try {
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: inputId ? { exact: inputId } : undefined,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1
        },
        video: false
      });
      micRef.current = mic;

      const outCtx = new AudioContext({ sampleRate: OUT_RATE, latencyHint: "interactive" });
      if (outputId && outputId !== "default" && (outCtx as any).setSinkId) {
        await (outCtx as any).setSinkId(outputId);
      }
      outCtxRef.current = outCtx;
      playheadRef.current = 0;

      const inCtx = new AudioContext({ latencyHint: "interactive" });
      inCtxRef.current = inCtx;
      const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: "application/javascript" }));
      await inCtx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);

      const source = inCtx.createMediaStreamSource(mic);
      const tap = new AudioWorkletNode(inCtx, "vc-tap");
      source.connect(tap);

      // Phrase detection on ~20 ms frames
      const rate = inCtx.sampleRate;
      const frameLen = Math.round((rate * FRAME_MS) / 1000);
      let pending = new Float32Array(0);
      const preRoll: Float32Array[] = [];
      const preRollFrames = Math.ceil(PRE_ROLL_MS / FRAME_MS);
      let phrase: Float32Array[] = [];
      let inPhrase = false;
      let silentMs = 0;
      let phraseMs = 0;

      const flush = () => {
        const voicedMs = phraseMs - silentMs;
        const audio = concat(phrase);
        phrase = [];
        inPhrase = false;
        setSpeaking(false);
        if (voicedMs < MIN_PHRASE_MS) return;
        const endedAt = performance.now();
        const pcm16k = resample(audio, rate, IN_RATE);
        // convert phrases one at a time so playback stays in order
        queueRef.current = queueRef.current.then(() => convertPhrase(pcm16k, endedAt));
      };

      tap.port.onmessage = (ev: MessageEvent<Float32Array>) => {
        const merged = new Float32Array(pending.length + ev.data.length);
        merged.set(pending);
        merged.set(ev.data, pending.length);
        let off = 0;
        while (merged.length - off >= frameLen) {
          const frame = merged.slice(off, off + frameLen);
          off += frameLen;

          let sum = 0;
          for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
          const rms = Math.sqrt(sum / frame.length);
          // sensitivity 0..100 -> RMS threshold ~0.06 (needs loud speech) .. ~0.004 (picks up whispers)
          const threshold = 0.06 * Math.pow(0.07, settingsRef.current.sensitivity / 100);
          const voiced = rms > threshold;

          if (!inPhrase) {
            preRoll.push(frame);
            if (preRoll.length > preRollFrames) preRoll.shift();
            if (voiced) {
              inPhrase = true;
              setSpeaking(true);
              phrase = preRoll.splice(0);
              silentMs = 0;
              phraseMs = phrase.length * FRAME_MS;
            }
            continue;
          }

          phrase.push(frame);
          phraseMs += FRAME_MS;
          silentMs = voiced ? 0 : silentMs + FRAME_MS;
          if (silentMs >= settingsRef.current.pauseMs || phraseMs >= MAX_PHRASE_MS) flush();
        }
        pending = merged.slice(off);
      };

      runningRef.current = true;
      setRunning(true);
      setPhrases(0);
      setLastLatency(null);
    } catch (e: any) {
      setError(e?.message || "Could not start the voice changer.");
      stop();
    }
  };

  const stop = () => {
    runningRef.current = false;
    micRef.current?.getTracks().forEach(t => t.stop());
    micRef.current = null;
    inCtxRef.current?.close().catch(() => {});
    inCtxRef.current = null;
    outCtxRef.current?.close().catch(() => {});
    outCtxRef.current = null;
    queueRef.current = Promise.resolve();
    setRunning(false);
    setSpeaking(false);
    setBusy(false);
  };

  useEffect(() => stop, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------- UI ---------- */
  const status = !running ? "Off" : busy ? "Converting…" : speaking ? "Listening…" : "Ready";
  const outputLabel = outputs.find(d => d.id === outputId)?.label || "";

  return (
    <div style={styles.section}>
      <div style={styles.sectionTitle}>Voice changer (ElevenLabs)</div>

      <div style={styles.labelRow}>
        <div style={styles.label}>ElevenLabs API key</div>
        <button style={{ ...styles.btn("ghost"), ...styles.btnSmall }} onClick={() => loadVoices()} disabled={!apiKey}>
          Load voices
        </button>
      </div>
      <input
        style={styles.input}
        type="password"
        placeholder="Paste your ElevenLabs API key…"
        value={apiKey}
        onChange={e => setApiKey(e.target.value)}
        onBlur={() => loadVoices()}
        disabled={running}
      />

      <div style={{ marginTop: 10 }}>
        <div style={styles.labelRow}>
          <div style={styles.label}>Voice</div>
          <div style={styles.value}>{voices.length ? `${voices.length} available` : "—"}</div>
        </div>
        <select style={styles.input} value={voiceId} onChange={e => setVoiceId(e.target.value)}>
          {!voices.length && <option value="">Load voices first</option>}
          {voices.map(v => (
            <option key={v.voice_id} value={v.voice_id}>
              {v.name}
              {v.category === "cloned" ? " (your clone)" : ""}
            </option>
          ))}
        </select>
        <div style={{ marginTop: 6, ...styles.hint }}>You can switch voices while it's running.</div>
      </div>

      <details style={{ marginTop: 10 }}>
        <summary style={{ ...styles.label, cursor: "pointer" }}>Clone a voice from a sample</summary>
        <div style={{ marginTop: 8, display: "grid", gap: 8 }}>
          <input style={styles.input} placeholder="Voice name" value={cloneName} onChange={e => setCloneName(e.target.value)} />
          <input
            style={styles.input}
            type="file"
            accept="audio/*"
            multiple
            onChange={e => setCloneFiles(Array.from(e.target.files || []))}
          />
          <button
            style={{ ...styles.btn("purple"), ...styles.btnSmall }}
            onClick={cloneVoice}
            disabled={cloning || !cloneFiles.length || !apiKey}
          >
            {cloning ? "Cloning…" : `Clone voice${cloneFiles.length ? ` (${cloneFiles.length} file${cloneFiles.length > 1 ? "s" : ""})` : ""}`}
          </button>
          <div style={styles.hint}>
            Upload 1–2 minutes of clean speech (no music or background noise). Only clone your own voice or one you have
            permission to use.
          </div>
        </div>
      </details>

      <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <div>
          <div style={styles.labelRow}>
            <div style={styles.label}>Your mic</div>
          </div>
          <select style={styles.input} value={inputId} onChange={e => setInputId(e.target.value)} disabled={running}>
            {inputs.map(d => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <div style={styles.labelRow}>
            <div style={styles.label}>Send voice to</div>
          </div>
          <select style={styles.input} value={outputId} onChange={e => setOutputId(e.target.value)} disabled={running}>
            {outputs.map(d => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div style={{ marginTop: 6, ...styles.hint }}>
        {/cable input/i.test(outputLabel)
          ? 'In OBS, set your mic source to "CABLE Output (VB-Audio Virtual Cable)".'
          : 'Tip: choose "CABLE Input (VB-Audio Virtual Cable)" to send the voice to OBS.'}
      </div>

      <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <div>
          <div style={styles.labelRow}>
            <div style={styles.label}>Mic sensitivity</div>
            <div style={styles.value}>{sensitivity}</div>
          </div>
          <input style={styles.slider} type="range" min={0} max={100} value={sensitivity} onChange={e => setSensitivity(+e.target.value)} />
        </div>
        <div>
          <div style={styles.labelRow}>
            <div style={styles.label}>Pause to send</div>
            <div style={styles.value}>{pauseMs} ms</div>
          </div>
          <input style={styles.slider} type="range" min={250} max={1200} step={50} value={pauseMs} onChange={e => setPauseMs(+e.target.value)} />
        </div>
      </div>
      <div style={{ marginTop: 6, ...styles.hint }}>
        Shorter pause = faster but may cut mid-sentence. Raise sensitivity if quiet speech is missed.
      </div>

      <label style={{ ...styles.pill, cursor: "pointer", marginTop: 10 }}>
        <input type="checkbox" checked={removeNoise} onChange={e => setRemoveNoise(e.target.checked)} style={{ accentColor: "#7c3aed" }} />
        Remove background noise (slower)
      </label>

      <div style={{ marginTop: 10, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <button style={{ ...styles.btn(running ? "danger" : "purple"), flex: 1 }} onClick={running ? stop : start}>
          {running ? "Stop voice changer" : "Start voice changer"}
        </button>
        <span style={styles.pill}>{status}</span>
      </div>

      <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
        <span style={styles.pill}>Phrases: {phrases}</span>
        <span style={styles.pill}>Delay: {lastLatency != null ? `${(lastLatency / 1000).toFixed(1)}s` : "—"}</span>
      </div>

      {info && <div style={{ marginTop: 8, ...styles.hint, color: "rgba(134,239,172,0.95)" }}>{info}</div>}
      {error && <div style={{ marginTop: 8, ...styles.hint, color: "rgba(252,165,165,0.95)" }}>{error}</div>}
    </div>
  );
}
