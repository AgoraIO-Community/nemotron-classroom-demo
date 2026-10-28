import {
  AgoraClient,
  Agent,
  Area,
  DeepgramSTT,
  ExpiresIn,
  MiniMaxTTS,
  OpenAI,
} from "agora-agents";
import { assertHost, errorResponse, required, validChannel } from "@/lib/server";

export const runtime = "nodejs";

const GREETING = "Hi, I'm your classroom assistant. Ask me to clarify an idea or help answer a question.";
const INSTRUCTIONS = `You are a concise teaching assistant in a live class. The human host leads the lesson.
Listen to the host and answer when the host addresses you. Help explain concepts, give short examples,
and suggest a focused question for the class when asked. Keep most replies to one or two sentences.
If you do not know a fact, say so. Do not claim to see shared slides or the class video.`;

function client() {
  return new AgoraClient({
    area: Area.US,
    appId: required("AGORA_APP_ID"),
    appCertificate: required("AGORA_APP_CERTIFICATE"),
  });
}

function alreadyStopped(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { statusCode?: number; body?: { detail?: string; reason?: string }; message?: string };
  const detail = (value.body?.detail || value.message || "").toLowerCase();
  return value.statusCode === 404 ||
    (value.body?.reason?.toLowerCase() === "invalidrequest" && detail.includes("already in the process of shutting down"));
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    assertHost(body.hostKey);
    if (body.action === "stop") {
      if (typeof body.agentId !== "string" || !body.agentId) throw new Error("Missing agent ID");
      try { await client().stopAgent(body.agentId); }
      catch (error) { if (!alreadyStopped(error)) throw error; }
      return Response.json({ success: true });
    }
    if (body.action !== "start") throw new Error("Unknown assistant action");
    const channel = validChannel(body.channel);
    const hostUid = Number(body.hostUid);
    if (!Number.isSafeInteger(hostUid) || hostUid < 1) throw new Error("Invalid host UID");

    // Adapted from Agora's official agent-quickstart-nextjs invite route.
    const agent = new Agent({
      client: client(),
      instructions: INSTRUCTIONS,
      greeting: GREETING,
      failureMessage: "Please wait a moment.",
      maxHistory: 50,
      turnDetection: {
        config: {
          speech_threshold: 0.5,
          start_of_speech: {
            mode: "vad",
            vad_config: { interrupt_duration_ms: 160, prefix_padding_ms: 300 },
          },
          end_of_speech: {
            mode: "vad",
            vad_config: { silence_duration_ms: 480 },
          },
        },
      },
      advancedFeatures: { enable_rtm: true, enable_tools: true },
      parameters: {
        audio_scenario: "chorus",
        data_channel: "rtm",
        enable_error_message: true,
        enable_metrics: true,
      },
    })
      .withStt(new DeepgramSTT({ model: "nova-3", language: "en" }))
      .withLlm(new OpenAI({
        model: "gpt-4o-mini",
        greetingMessage: GREETING,
        failureMessage: "Please wait a moment.",
        maxHistory: 15,
        params: { max_tokens: 1024, temperature: 0.7, top_p: 0.95 },
      }))
      .withTts(new MiniMaxTTS({
        model: "speech_2_6_turbo",
        voiceId: "English_captivating_female1",
      }));
    const session = agent.createSession({
      channel,
      agentUid: "123456",
      remoteUids: [String(hostUid)],
      idleTimeout: 30,
      expiresIn: ExpiresIn.hours(1),
      debug: false,
    });
    const agentId = await session.start();
    return Response.json({ agentId, state: "RUNNING" });
  } catch (error) {
    return errorResponse(error);
  }
}
