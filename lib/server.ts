import { RtcRole, RtcTokenBuilder } from "agora-token";

export function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name} in .env.local`);
  return value;
}

export function assertHost(key: unknown): void {
  const expected = required("DEMO_HOST_KEY");
  if (typeof key !== "string" || key !== expected) throw new Error("Invalid host key");
}

export function validChannel(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{3,40}$/.test(value)) {
    throw new Error("Channel must be 3–40 letters, digits, hyphens, or underscores");
  }
  return value;
}

export function rtcToken(channel: string, uid: number, publisher: boolean): string {
  return RtcTokenBuilder.buildTokenWithUid(
    required("AGORA_APP_ID"),
    required("AGORA_APP_CERTIFICATE"),
    channel,
    uid,
    publisher ? RtcRole.PUBLISHER : RtcRole.SUBSCRIBER,
    3600,
    3600,
  );
}

export function errorResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : "Request failed";
  const status = message === "Invalid host key" ? 403 : 400;
  return Response.json({ error: message }, { status });
}
