import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ org: string; workspace: string; app: string }> }
) {
  const { org, workspace, app } = await context.params;
  const key = process.env.SARVAM_VOICE_AGENT_API_KEY;
  if (!key || org !== process.env.SARVAM_ORG_ID ||
      workspace !== process.env.SARVAM_WORKSPACE_ID ||
      app !== process.env.SARVAM_VOICE_APP_ID) {
    return NextResponse.json({ error: "Voice agent is not configured." }, { status: 503 });
  }
  const remote = new URL(`https://apps.sarvam.ai/api/app-runtime/orgs/${encodeURIComponent(org)}/workspaces/${encodeURIComponent(workspace)}/apps/${encodeURIComponent(app)}/url`);
  for (const name of ["interaction_type", "version", "user_identifier", "user_identifier_type"]) {
    const value = request.nextUrl.searchParams.get(name);
    if (value) remote.searchParams.set(name, value);
  }
  try {
    const response = await fetch(remote, { headers: { "X-API-Key": key }, cache: "no-store" });
    return new NextResponse(await response.text(), {
      status: response.status,
      headers: { "Content-Type": response.headers.get("Content-Type") ?? "application/json" }
    });
  } catch {
    return NextResponse.json({ error: "Sarvam voice connection failed." }, { status: 502 });
  }
}
