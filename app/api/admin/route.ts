import { NextRequest, NextResponse } from "next/server";
import { allOrders, cancelOrder, PosError, setOrderStatus, setStock, updateProduct } from "@/lib/pos";

export const runtime = "nodejs";

function failure(error: unknown) {
  return NextResponse.json(
    { error: error instanceof Error ? error.message : "Request failed." },
    { status: error instanceof PosError ? error.status : 500 }
  );
}

export async function GET() {
  try { return NextResponse.json(await allOrders()); }
  catch (error) { return failure(error); }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    if (body.action === "order") return NextResponse.json(await setOrderStatus(String(body.id), String(body.status)));
    if (body.action === "stock") return NextResponse.json(await setStock(String(body.id), Number(body.stock)));
    if (body.action === "product") return NextResponse.json(await updateProduct(String(body.id), Number(body.pricePaise), Number(body.stock), body.active));
    if (body.action === "cancel") return NextResponse.json(await cancelOrder(String(body.id)));
    throw new PosError("Unknown action.");
  } catch (error) { return failure(error); }
}
