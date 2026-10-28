# Agora Classroom + Nemotron Transcribe demo

A local Next.js demo of a live class with browser VOD and NVIDIA Nemotron transcription:

1. The host publishes camera and microphone to an Agora RTC live channel.
2. A second RTC client publishes screen content while viewers join as audience.
3. The host browser records a composed video: shared screen with camera inset, or camera full screen. It mixes the host microphone, shared system audio when available, and remote agent audio.
4. The recording is saved in that browser's IndexedDB and can be played or downloaded from the **On demand** panel.
5. When recording stops, the browser uploads the finished file to the local Next.js server. FFmpeg converts its audio to 10-minute FLAC chunks; the server sends them sequentially to the configured Nemotron Transcribe endpoint and returns word-timed text.

Agora handles the **live** media. You run the NVIDIA model on a compatible inference host of your choice. Only recording storage and VOD playback are local to the browser. This avoids Cloud Recording, S3, and Agora REST customer credentials for a simple demo.

## Run

Requirements: Node.js 22+, pnpm, an Agora token-enabled project, and access to a compatible NVIDIA Nemotron 3.5 Transcribe deployment. The project installs FFmpeg and FFprobe for the host platform.

```bash
pnpm install
pnpm dev
```

For a fresh copy of this project, copy `.env.example` to `.env.local` and set `AGORA_APP_ID`, `AGORA_APP_CERTIFICATE`, a private `DEMO_HOST_KEY`, and `TRANSCRIBE_ENDPOINT` to the base URL of your compatible Nemotron Transcribe deployment. If your host requires bearer authentication, also set `TRANSCRIBE_API_KEY`. Set `TRANSCRIBE_MODEL` only if your server advertises a different model alias. No deployment URL or credentials are included in this repository. Keep `.env.local` private. The host key protects publishing and agent controls. Saved recordings can be transcribed after a refresh without re-entering the key.

Open the local URL printed by Next.js. Use two tabs or devices: one as **Host**, one as **Viewer**.

Start a class as host. The camera starts off and is not opened until you press **Camera on**; the stage shows a labeled teacher demo image while it is off. You can share content and record with the camera off. Press **Stop recording** to save the local VOD and start transcription. The recording remains in the same browser after a refresh. Use **Download video** to keep a separate copy.

Play the saved video and check its audio before trusting the transcript. After transcription, expand **Transcription receipt** to see the uploaded file's SHA-256, measured audio duration and level, endpoint, requested and returned model, and response ID. The server rejects recordings whose audio is effectively silent. These checks verify the request path and input signal, but only listening to the recording can establish whether the words are accurate. The model's output budget is limited in proportion to audio duration to reduce fabricated text on short clips.

## Host the NVIDIA model

The [official NVIDIA Nemotron 3.5 Transcribe model card](https://huggingface.co/nvidia/NVIDIA-Nemotron-3.5-Transcribe-30B-A4B) is the source for current weights, hardware requirements, and server commands. Obtain access to the model and choose a GPU provider that can run its supported vLLM deployment. NVIDIA's published BF16 example uses an H100 80 GB GPU. Follow the model card's vLLM V1 instructions, including its CTC timestamp middleware and multimodal request kwargs; a generic speech-to-text endpoint will not provide the response shape this demo needs.

Expose the model server over HTTPS (or use a private network reachable by your Next.js server). Set `TRANSCRIBE_ENDPOINT` to its base URL, without `/v1/chat/completions`. If the provider adds bearer authentication, set `TRANSCRIBE_API_KEY`. The default requested model is `nvidia/NVIDIA-Nemotron-3.5-Transcribe-30B-A4B`; if you configure `--served-model-name` or your provider uses another alias, set `TRANSCRIBE_MODEL` to that exact returned model name.

The app sends a 16 kHz mono FLAC audio URL in an OpenAI-compatible chat completion request with `mm_processor_kwargs.capture_ctc_timestamps` enabled. It requires `ctc_timestamps.words` in the response, with numeric start and end times. Confirm that response on a short audio clip before trying the classroom workflow. This is a server-side integration: never put the model endpoint key into a `NEXT_PUBLIC_` variable.

A Brev-hosted vLLM instance was used while developing this demo. If using Brev, create an instance with the GPU and storage required by the model card, deploy the same vLLM service, make the base URL reachable from the Next.js host, then set the variables above. The deprecated `BREV_ENDPOINT` variable is accepted for existing deployments.

## AI teaching assistant

The NVIDIA model transcribes **recorded audio**; it is not a live voice agent. **Start AI assistant** uses Agora Conversational AI's managed STT, LLM, and TTS providers. The agent listens to the host's microphone and publishes spoken replies into the class channel. This app's agent route follows the [official Next.js quickstart](https://github.com/AgoraIO-Conversational-AI/agent-quickstart-nextjs). A test agent reached `RUNNING`; a classroom viewer subscribed to and played its audio; and this app's assistant route started and stopped an agent successfully. A human speaking interaction has not yet been completed in this environment.

## Demo limits

- Recordings are private to the host browser and device. Other viewers cannot open its IndexedDB library; use **Download video** to share a file.
- Anyone with a channel name can watch. The host key protects publishing and agent controls, but this is not a production identity system. Anyone who can reach this demo server can submit a recording to its transcription route; keep the server on a trusted network.
- The browser must stay open while recording. Browser storage quotas vary, so use short classes for the demo and download important files.
- The local server reads the finished file into memory before conversion. It accepts files up to 1 GB. For large classes, use durable object storage and a background job.
- Screen sharing audio depends on browser and OS support. The camera inset is part of the recorded video, while the live viewer sees camera and screen as separate RTC streams.
- Nemotron word timing is shifted by each audio chunk's duration. Speaker IDs are local labels for each chunk.

## Deploying the web app on Vercel

Import this repository as a Next.js project with the repository root as the project root. Set `AGORA_APP_ID`, `AGORA_APP_CERTIFICATE`, `DEMO_HOST_KEY`, and `TRANSCRIBE_ENDPOINT` in the Vercel project's environment variables. The deployment URL must be reachable from Vercel's servers.

The transcription route bundles FFmpeg and FFprobe, so it does not depend on system executables on Vercel. Standard Vercel Functions still limit request bodies to 4.5 MB; recordings above that size need a separate large-file upload and processing flow. The transcription route is capped at 300 seconds for a Vercel Hobby deployment. Use a short recording below 4.5 MB to test this deployment path.
