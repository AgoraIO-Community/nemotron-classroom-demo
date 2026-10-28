import { transcribeRecording } from "@/lib/transcription";
import { errorResponse } from "@/lib/server";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const file = form.get("recording");
    if (!(file instanceof File)) throw new Error("Missing recording file");
    return Response.json(await transcribeRecording(file));
  } catch (error) {
    return errorResponse(error);
  }
}
