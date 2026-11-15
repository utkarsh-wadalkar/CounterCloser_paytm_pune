import { NextResponse } from "next/server";

export async function GET() {
  const configured = Boolean(
    process.env.SARVAM_VOICE_AGENT_API_KEY &&
    process.env.SARVAM_VOICE_APP_ID &&
    process.env.SARVAM_ORG_ID &&
    process.env.SARVAM_WORKSPACE_ID
  );
  return NextResponse.json({
    configured,
    appId: configured ? process.env.SARVAM_VOICE_APP_ID : null,
    orgId: configured ? process.env.SARVAM_ORG_ID : null,
    workspaceId: configured ? process.env.SARVAM_WORKSPACE_ID : null
  });
}
