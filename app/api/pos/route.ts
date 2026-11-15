import { NextRequest, NextResponse } from "next/server";
import { addMany, changeCart, clearCart, confirmOrder, PosError, state, tableNumber } from "@/lib/pos";

export const runtime = "nodejs";

function failure(error: unknown) {
  return NextResponse.json(
    { error: error instanceof Error ? error.message : "Request failed." },
    { status: error instanceof PosError ? error.status : 500 }
  );
}

export async function GET(request: NextRequest) {
  try {
    return NextResponse.json(await state(tableNumber(request.nextUrl.searchParams.get("table"))));
  } catch (error) { return failure(error); }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const table = tableNumber(body.table);
    if (body.action === "cart") {
      return NextResponse.json(await changeCart(table, String(body.productId), Number(body.delta), String(body.optionName ?? ""), String(body.requestId ?? "")));
    }
    if (body.action === "addMany") return NextResponse.json(await addMany(table, body.lines, String(body.requestId ?? "")));
    if (body.action === "confirm") return NextResponse.json(await confirmOrder(table));
    if (body.action === "clear") return NextResponse.json(await clearCart(table));
    throw new PosError("Unknown action.");
  } catch (error) { return failure(error); }
}
