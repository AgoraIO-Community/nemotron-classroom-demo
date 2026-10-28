import { readdir, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

export type Word = { word: string; start: number; end: number; speaker?: string | number };
export type Segment = { offset: number; text: string; words: Word[] };
export const TRANSCRIPTION_MODEL = process.env.TRANSCRIBE_MODEL || "nvidia/NVIDIA-Nemotron-3.5-Transcribe-30B-A4B";
export type Verification = {
  recordingSha256: string;
  audioDurationSeconds: number;
  meanVolumeDb: number | null;
  peakVolumeDb: number | null;
  requestedModel: string;
  returnedModels: string[];
  endpointHost: string;
  responseIds: string[];
  chunkCount: number;
};

function transcribeEndpoint(): string {
  const endpoint = process.env.TRANSCRIBE_ENDPOINT || process.env.BREV_ENDPOINT;
  if (!endpoint) throw new Error("Missing TRANSCRIBE_ENDPOINT");
  return endpoint.replace(/\/$/, "");
}

async function run(program: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-10000); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${program} failed: ${stderr}`)));
  });
}

function mediaTool(name: "ffmpeg" | "ffprobe"): string {
  if (name === "ffmpeg") {
    return join(process.cwd(), "node_modules", "ffmpeg-static", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
  }
  return join(process.cwd(), "node_modules", "ffprobe-static", "bin", process.platform, process.arch, process.platform === "win32" ? "ffprobe.exe" : "ffprobe");
}

function volumeDb(output: string, name: string): number | null {
  const match = output.match(new RegExp(`${name}:\\s*(-?\\d+(?:\\.\\d+)?|-inf)\\s*dB`));
  return match && match[1] !== "-inf" ? Number(match[1]) : null;
}

async function durationSeconds(path: string): Promise<number> {
  const { stdout } = await run(mediaTool("ffprobe"), [
    "-v", "error", "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1", path,
  ]);
  const duration = Number(stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("Could not measure recorded audio duration");
  return duration;
}

async function transcribe(flacPath: string, duration: number): Promise<{ text: string; words: Word[]; model: string; id: string }> {
  const audio = await readFile(flacPath);
  const endpoint = transcribeEndpoint();
  const response = await fetch(`${endpoint}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "agora-classroom-demo/1.0",
      ...(process.env.TRANSCRIBE_API_KEY ? { Authorization: `Bearer ${process.env.TRANSCRIBE_API_KEY}` } : {}),
    },
    body: JSON.stringify({
      model: TRANSCRIPTION_MODEL,
      messages: [{ role: "user", content: [
        { type: "text", text: "Transcribe this class audio. Include all spoken words." },
        { type: "audio_url", audio_url: { url: `data:audio/flac;base64,${audio.toString("base64")}` } },
      ] }],
      temperature: 0,
      max_tokens: Math.max(64, Math.min(16384, Math.ceil(duration * 20))),
      stream: false,
      chat_template_kwargs: { enable_thinking: false },
      n: 1,
      mm_processor_kwargs: { capture_ctc_timestamps: true },
      skip_special_tokens: false,
      spaces_between_special_tokens: false,
    }),
    signal: AbortSignal.timeout(1_200_000),
  });
  if (!response.ok) throw new Error(`Nemotron ${response.status}: ${(await response.text()).slice(0, 500)}`);
  const result = await response.json();
  if (result.model && result.model !== TRANSCRIPTION_MODEL) throw new Error(`Unexpected transcription model: ${result.model}`);
  const choice = result.choices?.[0];
  if (choice?.finish_reason !== "stop") throw new Error("Nemotron returned an incomplete transcript");
  const words = result.ctc_timestamps?.words;
  if (result.ctc_timestamps?.error || !Array.isArray(words)) throw new Error("Nemotron returned no usable word alignment");
  return {
    text: String(choice.message.content),
    words: words as Word[],
    model: typeof result.model === "string" ? result.model : "Not reported",
    id: typeof result.id === "string" ? result.id : "Not reported",
  };
}

export async function transcribeRecording(file: File): Promise<{ segments: Segment[]; verification: Verification }> {
  if (!file.type.startsWith("video/") && !file.type.startsWith("audio/")) {
    throw new Error("Upload a browser recording");
  }
  if (file.size > 1_000_000_000) throw new Error("This demo accepts recordings up to 1 GB");
  const folder = join(tmpdir(), `agora-class-${randomUUID()}`);
  await mkdir(folder, { recursive: true });
  try {
    const source = join(folder, "class-recording");
    const recording = Buffer.from(await file.arrayBuffer());
    const recordingSha256 = createHash("sha256").update(recording).digest("hex");
    await writeFile(source, recording);
    const { stderr: levels } = await run(mediaTool("ffmpeg"), [
      "-hide_banner", "-nostats", "-i", source, "-vn", "-af", "volumedetect", "-f", "null", "-",
    ]);
    const meanVolumeDb = volumeDb(levels, "mean_volume");
    const peakVolumeDb = volumeDb(levels, "max_volume");
    if (peakVolumeDb === null || peakVolumeDb <= -55) {
      throw new Error(`The recorded audio is silent or nearly silent (peak ${peakVolumeDb?.toFixed(1) ?? "none"} dB). Play the video, check the microphone, and record again.`);
    }
    await run(mediaTool("ffmpeg"), [
      "-hide_banner", "-loglevel", "error", "-i", source, "-vn", "-ac", "1", "-ar", "16000",
      "-c:a", "flac", "-f", "segment", "-segment_time", "600", join(folder, "part-%03d.flac"),
    ]);
    const files = (await readdir(folder)).filter((name) => name.endsWith(".flac")).sort();
    if (!files.length) throw new Error("The recording has no audio");
    const partDurations = await Promise.all(files.map((part) => durationSeconds(join(folder, part))));
    const audioDurationSeconds = partDurations.reduce((total, duration) => total + duration, 0);
    const segments: Segment[] = [];
    const returnedModels: string[] = [];
    const responseIds: string[] = [];
    let offset = 0;
    for (const [index, part] of files.entries()) {
      const path = join(folder, part);
      const partDuration = partDurations[index];
      const result = await transcribe(path, partDuration);
      returnedModels.push(result.model);
      responseIds.push(result.id);
      segments.push({
        offset,
        text: result.text,
        words: result.words.map((word) => ({
          ...word,
          start: word.start + offset,
          end: word.end + offset,
        })),
      });
      offset += partDuration;
    }
    return {
      segments,
      verification: {
        recordingSha256,
        audioDurationSeconds,
        meanVolumeDb,
        peakVolumeDb,
        requestedModel: TRANSCRIPTION_MODEL,
        returnedModels,
        endpointHost: new URL(transcribeEndpoint()).host,
        responseIds,
        chunkCount: files.length,
      },
    };
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}
