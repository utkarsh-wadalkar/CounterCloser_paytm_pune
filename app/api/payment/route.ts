import { NextRequest, NextResponse } from "next/server";
import { createQr, paymentConfigured, verifyPayment } from "@/lib/paytm";
import { PosError } from "@/lib/pos";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({ configured: paymentConfigured(), environment: process.env.PAYTM_ENV || "staging" });
}

export async function POST(request: NextRequest) {
  try {
    const { action, orderId } = await request.json();
    if (typeof orderId !== "string") throw new PosError("Invalid order ID.");
    if (action === "create") return NextResponse.json(await createQr(orderId));
    if (action === "verify") return NextResponse.json(await verifyPayment(orderId));
    throw new PosError("Unknown payment action.");
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Payment request failed." }, { status: error instanceof PosError ? error.status : 500 });
  }
}
