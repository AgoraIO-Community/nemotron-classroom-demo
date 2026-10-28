import { randomInt } from "node:crypto";
import { assertHost, errorResponse, required, rtcToken, validChannel } from "@/lib/server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const channel = validChannel(body.channel);
    const role = body.role === "host" ? "host" : "audience";
    if (role === "host") assertHost(body.hostKey);
    const uid = body.uid == null ? randomInt(2_000_000, 1_000_000_000) : Number(body.uid);
    if (!Number.isSafeInteger(uid) || uid < 1 || uid > 2_147_483_647) {
      throw new Error("Invalid numeric UID");
    }
    return Response.json({
      appId: required("AGORA_APP_ID"),
      channel,
      role,
      uid,
      token: rtcToken(channel, uid, role === "host"),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
