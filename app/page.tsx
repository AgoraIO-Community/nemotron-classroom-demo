"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  IAgoraRTCClient,
  IAgoraRTCRemoteUser,
  ICameraVideoTrack,
  ILocalTrack,
  IMicrophoneAudioTrack,
} from "agora-rtc-sdk-ng";
import { BrowserRecording, TranscriptionVerification, TranscriptSegment, listRecordings, saveRecording } from "@/lib/browser-recordings";

type Role = "host" | "audience";
type Session = { channel: string; uid: number; role: Role; appId: string };
const TEACHER_PLACEHOLDER = "/teacher-placeholder.jpg";
type RecorderSession = {
  recorder: MediaRecorder;
  canvasStream: MediaStream;
  context: AudioContext;
  frame: number;
  videos: HTMLVideoElement[];
  addAudioTrack: (track: MediaStreamTrack) => void;
  setCameraTrack: (track: MediaStreamTrack | null) => Promise<void>;
  setScreenTrack: (track: MediaStreamTrack | null) => Promise<void>;
};

function TeacherPlaceholder({ label }: { label: string }) {
  return <div className="teacher-placeholder">
    <img src={TEACHER_PLACEHOLDER} alt="" />
    <span className="teacher-placeholder-note">{label} · demo image</span>
  </div>;
}

function formatWordTime(seconds: number) {
  const hundredths = Math.round(Math.max(0, seconds) * 100);
  const minutes = Math.floor(hundredths / 6000);
  const wholeSeconds = Math.floor(hundredths / 100) % 60;
  return `${minutes}:${String(wholeSeconds).padStart(2, "0")}.${String(hundredths % 100).padStart(2, "0")}`;
}

function TimedTranscript({ segments }: { segments: TranscriptSegment[] }) {
  return <>
    {segments.map((segment, segmentIndex) => {
      const words = segment.words?.filter((word) =>
        typeof word.word === "string" && word.word.trim() && Number.isFinite(word.start) && word.start >= 0,
      ) ?? [];
      return words.length ? <div className="transcript-words" key={segmentIndex}>
        {words.map((word, wordIndex) => <span className="timed-word" key={`${segmentIndex}-${wordIndex}`}>
          <time>{formatWordTime(word.start)}</time>
          <span>{word.word.trim()}</span>
        </span>)}
      </div> : <p key={segmentIndex}>{segment.text}</p>;
    })}
  </>;
}

async function post<T>(url: string, body: object): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Request failed: ${response.status}`);
  return result as T;
}

export default function ClassroomPage() {
  const [channel, setChannel] = useState("classroom-demo");
  const [role, setRole] = useState<Role>("host");
  const [hostKey, setHostKey] = useState("");
  const [session, setSession] = useState<Session | null>(null);
  const [remoteUsers, setRemoteUsers] = useState<IAgoraRTCRemoteUser[]>([]);
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraBusy, setCameraBusy] = useState(false);
  const [micOn, setMicOn] = useState(true);
  const [sharing, setSharing] = useState(false);
  const [assistantId, setAssistantId] = useState<string | null>(null);
  const [recordingActive, setRecordingActive] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [library, setLibrary] = useState<BrowserRecording[]>([]);
  const [selected, setSelected] = useState<BrowserRecording | null>(null);
  const [videoUrl, setVideoUrl] = useState("");
  const [status, setStatus] = useState("Ready");
  const [error, setError] = useState("");
  const [transcriptionError, setTranscriptionError] = useState("");
  const clientRef = useRef<IAgoraRTCClient | null>(null);
  const screenRef = useRef<{ client: IAgoraRTCClient; tracks: ILocalTrack[] } | null>(null);
  const micRef = useRef<IMicrophoneAudioTrack | null>(null);
  const cameraRef = useRef<ICameraVideoTrack | null>(null);
  const assistantRef = useRef<string | null>(null);
  const recorderRef = useRef<RecorderSession | null>(null);
  const transcribingRef = useRef(false);

  const clearError = () => setError("");
  const report = (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause));

  useEffect(() => {
    if (cameraOn) cameraRef.current?.play("local-video");
  }, [session, cameraOn]);

  useEffect(() => {
    for (const user of remoteUsers) {
      if (user.videoTrack) {
        const element = document.getElementById(`remote-${user.uid}`);
        if (element) user.videoTrack.play(element);
      }
    }
  }, [remoteUsers]);

  const stopScreenShare = useCallback(async () => {
    const screen = screenRef.current;
    screenRef.current = null;
    if (!screen) return;
    await recorderRef.current?.setScreenTrack(null);
    for (const track of screen.tracks) { track.stop(); track.close(); }
    await screen.client.leave();
    setSharing(false);
  }, []);

  const leave = useCallback(async () => {
    try {
      if (recorderRef.current?.recorder.state === "recording") {
        recorderRef.current.recorder.stop();
        setRecordingActive(false);
      }
      if (assistantRef.current) {
        try {
          await post("/api/assistant", { action: "stop", agentId: assistantRef.current, hostKey });
          assistantRef.current = null;
          setAssistantId(null);
          window.localStorage.removeItem(`agora-assistant-${channel}`);
        } catch (cause) { report(cause); }
      }
      await stopScreenShare();
      for (const track of [micRef.current, cameraRef.current]) {
        if (track) { track.stop(); track.close(); }
      }
      micRef.current = null;
      cameraRef.current = null;
      await clientRef.current?.leave();
      clientRef.current = null;
      setRemoteUsers([]);
      setSession(null);
      setCameraOn(false);
      setStatus("Left class");
    } catch (cause) { report(cause); }
  }, [stopScreenShare, hostKey, channel]);

  const join = async () => {
    clearError();
    setStatus("Joining class…");
    try {
      const rtc = (await import("agora-rtc-sdk-ng")).default;
      const credentials = await post<Session & { token: string }>("/api/token", { channel, role, hostKey });
      const client = rtc.createClient({ mode: "live", codec: "vp8" });
      clientRef.current = client;
      await client.setClientRole(role);
      client.on("user-published", async (user, mediaType) => {
        try {
          await client.subscribe(user, mediaType);
          if (mediaType === "audio") {
            user.audioTrack?.play();
            const track = user.audioTrack?.getMediaStreamTrack();
            if (track) recorderRef.current?.addAudioTrack(track);
            setStatus(`Receiving live audio · ${String(user.uid)}`);
          }
          setRemoteUsers([...client.remoteUsers]);
        } catch (cause) { report(cause); }
      });
      client.on("user-unpublished", () => setRemoteUsers([...client.remoteUsers]));
      client.on("user-left", () => setRemoteUsers([...client.remoteUsers]));
      client.on("token-privilege-will-expire", async () => {
        const renewal = await post<{ token: string }>("/api/token", {
          channel, role, hostKey, uid: credentials.uid,
        });
        await client.renewToken(renewal.token);
      });
      await client.join(credentials.appId, channel, credentials.token, credentials.uid);
      if (role === "host") {
        const mic = await rtc.createMicrophoneAudioTrack({ encoderConfig: "speech_standard" });
        micRef.current = mic;
        await client.publish(mic);
        setMicOn(true);
        setCameraOn(false);
      }
      setSession({ channel, uid: credentials.uid, role, appId: credentials.appId });
      setStatus(role === "host" ? "Live as host" : "Watching live");
      window.history.replaceState(null, "", `?channel=${encodeURIComponent(channel)}`);
    } catch (cause) {
      report(cause);
      await leave();
      setStatus("Could not join");
    }
  };

  const toggleCamera = async () => {
    const client = clientRef.current;
    if (!session || session.role !== "host" || !client || cameraBusy) return;
    clearError();
    setCameraBusy(true);
    try {
      const active = cameraRef.current;
      if (active) {
        await client.unpublish(active);
        await recorderRef.current?.setCameraTrack(null);
        active.stop();
        active.close();
        cameraRef.current = null;
        setCameraOn(false);
        setStatus("Camera off");
      } else {
        const rtc = (await import("agora-rtc-sdk-ng")).default;
        const camera = await rtc.createCameraVideoTrack({ encoderConfig: "720p_1" });
        try {
          await client.publish(camera);
          await recorderRef.current?.setCameraTrack(camera.getMediaStreamTrack());
          cameraRef.current = camera;
          setCameraOn(true);
          setStatus("Camera on");
        } catch (cause) {
          await client.unpublish(camera).catch(() => {});
          camera.stop();
          camera.close();
          throw cause;
        }
      }
    } catch (cause) { report(cause); }
    finally { setCameraBusy(false); }
  };

  const startScreenShare = async () => {
    if (!session) return;
    clearError();
    try {
      const rtc = (await import("agora-rtc-sdk-ng")).default;
      const uid = session.uid + 1_000_000_000;
      const credentials = await post<{ token: string }>("/api/token", {
        channel: session.channel, role: "host", hostKey, uid,
      });
      const screenClient = rtc.createClient({ mode: "live", codec: "vp8" });
      await screenClient.setClientRole("host");
      screenClient.on("token-privilege-will-expire", async () => {
        const renewal = await post<{ token: string }>("/api/token", {
          channel: session.channel, role: "host", hostKey, uid,
        });
        await screenClient.renewToken(renewal.token);
      });
      const created = await rtc.createScreenVideoTrack({
        optimizationMode: "detail",
        encoderConfig: { width: 1280, height: 720, frameRate: 15 },
      }, "auto");
      const tracks = (Array.isArray(created) ? created.filter(Boolean) : [created]) as ILocalTrack[];
      screenRef.current = { client: screenClient, tracks };
      tracks[0].on("track-ended", () => { void stopScreenShare(); });
      await screenClient.join(session.appId, session.channel, credentials.token, uid);
      await screenClient.publish(tracks);
      await recorderRef.current?.setScreenTrack(tracks[0].getMediaStreamTrack());
      for (const track of tracks.slice(1)) {
        if (track.getMediaStreamTrack().kind === "audio") recorderRef.current?.addAudioTrack(track.getMediaStreamTrack());
      }
      setSharing(true);
      setStatus("Sharing screen");
    } catch (cause) {
      report(cause);
      await stopScreenShare();
    }
  };

  const chooseRecording = (record: BrowserRecording) => {
    setTranscriptionError("");
    setSelected(record);
    setVideoUrl(URL.createObjectURL(record.blob));
  };

  const refreshLibrary = async () => setLibrary(await listRecordings());

  const processRecording = async (record: BrowserRecording) => {
    if (transcribingRef.current) return;
    transcribingRef.current = true;
    setTranscribing(true);
    setTranscriptionError("");
    clearError();
    setStatus("Transcribing the finished recording…");
    try {
      const form = new FormData();
      form.append("recording", record.blob, record.blob.type.includes("mp4") ? "class.mp4" : "class.webm");
      const response = await fetch("/api/transcribe", { method: "POST", body: form });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Transcription failed");
      const verified = result as { segments: TranscriptSegment[]; verification: TranscriptionVerification };
      const updated = { ...record, segments: verified.segments, verification: verified.verification };
      await saveRecording(updated);
      chooseRecording(updated);
      await refreshLibrary();
      setStatus("Local VOD and transcript ready");
    } catch (cause) {
      setTranscriptionError(cause instanceof Error ? cause.message : String(cause));
      setStatus("Transcription stopped; recording remains saved");
    } finally {
      transcribingRef.current = false;
      setTranscribing(false);
    }
  };

  const startRecording = async () => {
    if (!session || !micRef.current) return;
    clearError();
    try {
      if (!window.MediaRecorder) throw new Error("This browser does not support MediaRecorder");
      const canvas = document.createElement("canvas");
      canvas.width = 1280;
      canvas.height = 720;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvas recording is unavailable");
      const videos: HTMLVideoElement[] = [];
      const videoFor = async (track: MediaStreamTrack) => {
        const video = document.createElement("video");
        video.muted = true;
        video.playsInline = true;
        video.srcObject = new MediaStream([track]);
        videos.push(video);
        await video.play();
        return video;
      };
      let cameraVideo: HTMLVideoElement | null = cameraRef.current
        ? await videoFor(cameraRef.current.getMediaStreamTrack()) : null;
      let screenVideo: HTMLVideoElement | null = null;
      const context = new AudioContext();
      await context.resume();
      const placeholder = new window.Image();
      placeholder.src = TEACHER_PLACEHOLDER;
      await placeholder.decode().catch(() => {});
      const destination = context.createMediaStreamDestination();
      const seen = new Set<string>();
      const addAudioTrack = (track: MediaStreamTrack) => {
        if (track.kind !== "audio" || seen.has(track.id)) return;
        seen.add(track.id);
        context.createMediaStreamSource(new MediaStream([track])).connect(destination);
      };
      addAudioTrack(micRef.current.getMediaStreamTrack());
      for (const user of clientRef.current?.remoteUsers ?? []) {
        const track = user.audioTrack?.getMediaStreamTrack();
        if (track) addAudioTrack(track);
      }
      const setScreenTrack = async (track: MediaStreamTrack | null) => {
        screenVideo = track ? await videoFor(track) : null;
      };
      const setCameraTrack = async (track: MediaStreamTrack | null) => {
        if (cameraVideo) { cameraVideo.pause(); cameraVideo.srcObject = null; }
        cameraVideo = track ? await videoFor(track) : null;
      };
      const screen = screenRef.current;
      if (screen) {
        await setScreenTrack(screen.tracks[0].getMediaStreamTrack());
        for (const track of screen.tracks.slice(1)) {
          if (track.getMediaStreamTrack().kind === "audio") addAudioTrack(track.getMediaStreamTrack());
        }
      }
      const draw = () => {
        ctx.fillStyle = "#0b0d13";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        const drawPlaceholder = (x: number, y: number, width: number, height: number) => {
          if (!placeholder.naturalWidth || !placeholder.naturalHeight) return;
          const scale = Math.max(width / placeholder.naturalWidth, height / placeholder.naturalHeight);
          const sourceWidth = width / scale;
          const sourceHeight = height / scale;
          ctx.drawImage(placeholder,
            (placeholder.naturalWidth - sourceWidth) / 2,
            (placeholder.naturalHeight - sourceHeight) / 2,
            sourceWidth, sourceHeight, x, y, width, height);
        };
        const primary = screenVideo ?? cameraVideo;
        if (primary && primary.readyState >= 2) {
          const ratio = Math.min(canvas.width / primary.videoWidth, canvas.height / primary.videoHeight);
          const width = primary.videoWidth * ratio;
          const height = primary.videoHeight * ratio;
          ctx.drawImage(primary, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
        } else if (!screenVideo) {
          drawPlaceholder(0, 0, canvas.width, canvas.height);
          ctx.fillStyle = "#071019d9";
          ctx.fillRect(24, 652, 294, 44);
          ctx.fillStyle = "#f1f8f5";
          ctx.font = "18px sans-serif";
          ctx.fillText("Camera off · demo image", 39, 681);
        }
        if (screenVideo) {
          ctx.fillStyle = "#141923";
          ctx.fillRect(978, 532, 284, 170);
          if (cameraVideo && cameraVideo.readyState >= 2) {
            ctx.drawImage(cameraVideo, 986, 540, 268, 152);
          } else {
            drawPlaceholder(986, 540, 268, 152);
            ctx.fillStyle = "#071019d9";
            ctx.fillRect(986, 676, 268, 16);
            ctx.fillStyle = "#f1f8f5";
            ctx.font = "11px sans-serif";
            ctx.fillText("Camera off · demo image", 994, 688);
          }
        }
        if (recorderRef.current) recorderRef.current.frame = requestAnimationFrame(draw);
      };
      const canvasStream = canvas.captureStream(15);
      const stream = new MediaStream([...canvasStream.getVideoTracks(), ...destination.stream.getAudioTracks()]);
      const mimeType = [
        "video/webm;codecs=vp9,opus",
        "video/webm;codecs=vp8,opus",
        "video/webm",
        "video/mp4",
      ].find((mime) => MediaRecorder.isTypeSupported(mime));
      if (!mimeType) throw new Error("No supported recording format in this browser");
      const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 1_000_000, audioBitsPerSecond: 96_000 });
      const chunks: BlobPart[] = [];
      recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      recorder.onerror = () => report(new Error("Browser recording failed"));
      recorder.onstop = async () => {
        const active = recorderRef.current;
        recorderRef.current = null;
        if (active) {
          cancelAnimationFrame(active.frame);
          active.canvasStream.getTracks().forEach((track) => track.stop());
          active.videos.forEach((video) => { video.pause(); video.srcObject = null; });
          await active.context.close();
        }
        setRecordingActive(false);
        const blob = new Blob(chunks, { type: mimeType });
        if (!blob.size) { report(new Error("The browser produced an empty recording")); return; }
        const record: BrowserRecording = {
          id: crypto.randomUUID(),
          channel: session.channel,
          createdAt: Date.now(),
          blob,
        };
        try {
          await saveRecording(record);
          chooseRecording(record);
          await refreshLibrary();
          await processRecording(record);
        } catch (cause) { report(cause); }
      };
      recorderRef.current = { recorder, canvasStream, context, frame: 0, videos, addAudioTrack, setCameraTrack, setScreenTrack };
      recorderRef.current.frame = requestAnimationFrame(draw);
      recorder.start(1000);
      setRecordingActive(true);
      setStatus("Recording locally in this browser");
    } catch (cause) { report(cause); }
  };

  const stopRecording = () => {
    if (recorderRef.current?.recorder.state === "recording") {
      recorderRef.current.recorder.stop();
      setStatus("Saving browser recording…");
    }
  };

  const toggleAssistant = async () => {
    if (!session) return;
    clearError();
    try {
      if (assistantRef.current) {
        await post("/api/assistant", { action: "stop", agentId: assistantRef.current, hostKey });
        assistantRef.current = null;
        setAssistantId(null);
        window.localStorage.removeItem(`agora-assistant-${session.channel}`);
        setStatus("AI assistant stopped");
      } else {
        setStatus("Starting AI teaching assistant…");
        const result = await post<{ agentId: string }>("/api/assistant", {
          action: "start", channel: session.channel, hostUid: session.uid, hostKey,
        });
        assistantRef.current = result.agentId;
        setAssistantId(result.agentId);
        window.localStorage.setItem(`agora-assistant-${session.channel}`, result.agentId);
        setStatus("AI teaching assistant is live");
      }
    } catch (cause) { report(cause); }
  };

  useEffect(() => {
    const url = new URL(window.location.href);
    const initialChannel = url.searchParams.get("channel");
    if (initialChannel) setChannel(initialChannel);
  }, []);

  useEffect(() => {
    try {
      const agent = window.localStorage.getItem(`agora-assistant-${channel}`);
      assistantRef.current = agent;
      setAssistantId(agent);
    } catch { /* Browser storage may be disabled. */ }
  }, [channel]);

  useEffect(() => {
    void refreshLibrary().catch(report);
  }, []);

  useEffect(() => () => {
    if (videoUrl) URL.revokeObjectURL(videoUrl);
  }, [videoUrl]);

  const shareUrl = typeof window !== "undefined"
    ? `${window.location.origin}?channel=${encodeURIComponent(channel)}`
    : "";

  return <main className="shell">
    <header className="topbar">
      <div className="brand"><span className="brand-mark">A</span><span>Agora <strong>Classroom</strong></span></div>
      <span className="eyebrow">LIVE CLASS • RECORD • TRANSCRIBE</span>
    </header>
    <section className="hero">
      <div>
        <span className="pill">DEMO WORKSPACE</span>
        <h1>Teach live.<br /><em>Keep the lesson.</em></h1>
        <p>Broadcast your camera and slides, record the class in this browser, then turn the recording into a local VOD with Nemotron Transcribe.</p>
      </div>
      <div className="hero-stat"><span className="pulse" />{status}</div>
    </section>

    {error && <div className="error" role="alert">{error}</div>}

    <section className="setup card">
      <div className="section-heading"><div><span className="step">01</span><h2>Class setup</h2></div><span>Share a channel name with your viewers</span></div>
      <div className="setup-grid">
        <label>Channel name<input value={channel} disabled={!!session} onChange={(e) => setChannel(e.target.value)} /></label>
        <label>Your role<select value={role} disabled={!!session} onChange={(e) => setRole(e.target.value as Role)}><option value="host">Host</option><option value="audience">Viewer</option></select></label>
        {role === "host" && <label>Host key<input type="password" value={hostKey} onChange={(e) => setHostKey(e.target.value)} placeholder="From .env.local" /></label>}
      </div>
      <div className="actions">
        {!session ? <button className="primary" onClick={join}>Join class <span>↗</span></button> : <button className="secondary" onClick={leave}>Leave class</button>}
        <button className="text-button" onClick={() => { void navigator.clipboard.writeText(shareUrl); setStatus("Viewer link copied"); }}>Copy viewer link ↗</button>
      </div>
    </section>

    <section className="stage card">
      <div className="section-heading"><div><span className="step">02</span><h2>Live classroom</h2></div><span>{session ? `Connected as ${session.role} · UID ${session.uid}` : "Join to preview media"}</span></div>
      <div className="video-grid">
        {session?.role === "host" && <div className="video-tile">
          <div id="local-video" className={`video${cameraOn ? "" : " video-hidden"}`} />
          {!cameraOn && <TeacherPlaceholder label="Camera off" />}
          <span className="tile-label">You · host</span>
        </div>}
        {remoteUsers.filter((user) => !!user.videoTrack).map((user) =>
          <div className="video-tile" key={String(user.uid)}><div id={`remote-${user.uid}`} className="video" /><span className="tile-label">Live · {String(user.uid)}</span></div>)}
        {!session && <div className="empty-stage"><div className="stage-icon">▶</div><strong>Your class appears here</strong><span>Camera, shared content, and viewers connect through Agora RTC.</span></div>}
        {session && session.role === "audience" && !remoteUsers.some((user) => !!user.videoTrack) && remoteUsers.some((user) => !!user.audioTrack) &&
          <div className="video-tile"><TeacherPlaceholder label="Host camera off" /><span className="tile-label">Live audio · host</span></div>}
        {session && session.role === "audience" && !remoteUsers.some((user) => !!user.videoTrack) && !remoteUsers.some((user) => !!user.audioTrack) &&
          <div className="empty-stage"><div className="stage-icon">◉</div><strong>Waiting for the host</strong><span>Keep this tab open. The class will appear when the host publishes.</span></div>}
      </div>
      {session?.role === "host" && <div className="toolbar">
        <button onClick={async () => { await micRef.current?.setEnabled(!micOn); setMicOn(!micOn); }}>{micOn ? "Mute mic" : "Unmute mic"}</button>
        <button disabled={cameraBusy} onClick={toggleCamera}>{cameraBusy ? "Updating camera…" : cameraOn ? "Camera off" : "Camera on"}</button>
        <button onClick={sharing ? stopScreenShare : startScreenShare}>{sharing ? "Stop sharing" : "Share content"}</button>
        <button onClick={toggleAssistant}>{assistantId ? "Stop AI assistant" : "Start AI assistant"}</button>
        <button className={recordingActive ? "danger" : ""} onClick={recordingActive ? stopRecording : startRecording}>{recordingActive ? "● Stop recording" : "○ Start recording"}</button>
      </div>}
    </section>

    <section className="vod-section card">
      <div className="section-heading"><div><span className="step">03</span><h2>On demand</h2></div><span>Browser recording → FLAC → Nemotron transcript</span></div>
      <div className="vod-grid">
        <div>
          <h3>Local recording library</h3>
          <p>Recordings stay in this browser. The finished file is sent to the local server for audio conversion, then to Nemotron for transcription.</p>
          <div className="recording-list">
            {library.length ? library.map((record) => <button
              className={selected?.id === record.id ? "recording-item selected" : "recording-item"}
              key={record.id}
              onClick={() => chooseRecording(record)}
            >
              <strong>{record.channel}</strong>
              <span>{new Date(record.createdAt).toLocaleString()} · {Math.round(record.blob.size / 1_000_000)} MB · {record.segments ? "Transcribed" : "No transcript"}</span>
            </button>) : <span className="library-empty">No recordings yet. Start a class and press Record.</span>}
          </div>
          {selected && <div className="actions">
            <button className="secondary" disabled={transcribing} onClick={() => processRecording(selected)}>{transcribing ? "Transcribing…" : selected.segments ? "Re-transcribe" : "Transcribe"}</button>
            <a className="text-button" href={videoUrl} download={`${selected.channel}-${new Date(selected.createdAt).toISOString().slice(0, 10)}.${selected.blob.type.includes("mp4") ? "mp4" : "webm"}`}>Download video ↗</a>
          </div>}
          {transcriptionError && <p className="transcription-error" role="alert">{transcriptionError}</p>}
        </div>
        <div className="vod-preview">
          {selected ? <>
            <video controls src={videoUrl} />
            <div className="transcript"><h3>Transcript</h3>
              <p className="verification-note">Times below mark individual words when the model provides alignment. Play the recording and compare what you hear with the text; timestamps and model identity do not prove accuracy.</p>
              {selected.segments ? <TimedTranscript segments={selected.segments} /> : <p>No transcript yet. Play the recording and check its sound before retrying.</p>}
              {selected.verification ? <details className="verification">
                <summary>Transcription receipt</summary>
                <dl>
                  <dt>Uploaded video SHA-256</dt><dd className="hash">{selected.verification.recordingSha256}</dd>
                  <dt>Detected audio</dt><dd>{selected.verification.audioDurationSeconds.toFixed(1)} seconds · average {selected.verification.meanVolumeDb?.toFixed(1) ?? "silent"} dB · peak {selected.verification.peakVolumeDb?.toFixed(1) ?? "silent"} dB</dd>
                  <dt>Endpoint</dt><dd>{selected.verification.endpointHost}</dd>
                  <dt>Requested model</dt><dd>{selected.verification.requestedModel}</dd>
                  <dt>Returned model</dt><dd>{selected.verification.returnedModels.join(", ")}</dd>
                  <dt>Response ID</dt><dd className="hash">{selected.verification.responseIds.join(", ")}</dd>
                  <dt>Audio chunks</dt><dd>{selected.verification.chunkCount}</dd>
                </dl>
              </details> : selected.segments && <p className="verification-note">This older transcript has no request receipt. Re-transcribe it to inspect the audio and model response.</p>}
            </div>
          </> : <div className="vod-placeholder"><span>▤</span><strong>Recording library</strong><small>Your processed lesson will appear here.</small></div>}
        </div>
      </div>
    </section>
    <footer>Agora live class · browser VOD · NVIDIA Nemotron transcription</footer>
  </main>;
}
