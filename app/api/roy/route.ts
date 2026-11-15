import { NextRequest, NextResponse } from "next/server";
import { addMany, changeCart, clearCart, confirmOrder, PosError, setCartOption, state, tableNumber } from "@/lib/pos";
import { createQr, verifyPayment } from "@/lib/paytm";

export const runtime = "nodejs";

type Product = {
  id: string; name: string; stock: number; price_paise: number;
  aliases: string[]; pairings: string[]; substitutes: string[]; options: string[];
  flavors: string[];
};
type Line = { productId: string; quantity: number; optionName?: string };

function quantityBefore(text: string, start: number) {
  const prefix = text.slice(Math.max(0, start - 24), start);
  const match = prefix.match(/(?:^|\s)(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)(?:\s+\w+){0,2}\s*$/);
  const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  return match ? Number(match[1]) || words[match[1]] || 1 : 1;
}

function mentioned(text: string, products: Product[]): Line[] {
  const found: { line: Line; start: number; end: number }[] = [];
  const aliases = products.flatMap(product =>
    [product.name.toLowerCase(), ...product.aliases.map(alias => alias.toLowerCase())]
      .map(alias => ({ product, alias }))
  ).sort((a, b) => b.alias.length - a.alias.length);
  const occupied: [number, number][] = [];
  for (const { product, alias } of aliases) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b${escaped}(?:s)?\\b`, "g");
    for (const match of text.matchAll(re)) {
      const start = match.index;
      const end = start + match[0].length;
      if (occupied.some(([a, b]) => start < b && end > a)) continue;
      if (/\b(?:no|without|skip)\s*$/.test(text.slice(Math.max(0, start - 12), start))) continue;
      occupied.push([start, end]);
      const optionName = [
        product.flavors.find(flavor => text.includes(flavor.toLowerCase())),
        product.options.find(option => text.includes(option.toLowerCase()))
      ].filter(Boolean).join(" · ");
      found.push({ line: { productId: product.id, quantity: quantityBefore(text, start), optionName }, start, end });
    }
  }
  return found.sort((a,b) => a.start - b.start).map(x => x.line);
}

function money(paise: number) { return `₹${(paise / 100).toFixed(0)}`; }

async function naturalize(message: string, facts: string) {
  const key = process.env.SARVAM_API_KEY;
  if (!key) return message;
  try {
    const response = await fetch("https://api.sarvam.ai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "api-subscription-key": key },
      body: JSON.stringify({
        model: "sarvam-105b-conversations", max_tokens: 120,
        messages: [
          { role: "system", content: "You are Roy, a warm, concise cafe waiter. Rewrite the supplied response as one natural spoken sentence. Preserve every product name, quantity, price, and question. Never introduce a new item, discount, availability claim, or payment claim. Output only the sentence." },
          { role: "user", content: `Catalog facts: ${facts}\nRequired response: ${message}` }
        ]
      }),
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) return message;
    const payload = await response.json();
    const candidate = payload?.choices?.[0]?.message?.content;
    if (typeof candidate !== "string" || candidate.length > 450 || candidate.length < 3) return message;
    // The deterministic response is authoritative for any quantity or price.
    const required = [...message.matchAll(/(?:₹\d+|\b\d+\b)/g)].map(match => match[0]);
    if (required.some(value => !candidate.includes(value))) return message;
    return candidate.trim();
  } catch { return message; }
}

async function menuAnswer(question: string, facts: string) {
  const key = process.env.SARVAM_API_KEY;
  if (!key) return "I can help with the menu. Tell me an item and quantity, or ask what’s available.";
  try {
    const response = await fetch("https://api.sarvam.ai/v1/chat/completions", {
      method: "POST", headers: { "Content-Type": "application/json", "api-subscription-key": key },
      body: JSON.stringify({ model: "sarvam-105b-conversations", max_tokens: 150, messages: [
        { role: "system", content: `You are Roy, a friendly cafe waiter. Answer in one or two short conversational sentences using only these current menu facts: ${facts}. Do not invent ingredients, discounts, availability, or payment state. Do not claim to have added an item. If the request is unclear, ask a simple follow-up question.` },
        { role: "user", content: question }
      ] }), signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) throw new Error("Chat unavailable");
    const payload = await response.json();
    const answer = payload?.choices?.[0]?.message?.content;
    return typeof answer === "string" && answer.length < 500 ? answer.trim() : "What would you like from the menu?";
  } catch { return "I can help with the menu. Tell me an item and quantity, or ask what’s available."; }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const table = tableNumber(body.table);
    const text = String(body.text ?? "").trim().slice(0, 500);
    const requestId = String(body.requestId ?? "");
    const current = await state(table);
    const products = current.products as Product[];
    const byId = new Map(products.map(product => [product.id, product]));
    const facts = products.map(product => `${product.name}: ${money(product.price_paise)}, ${product.stock} available, flavors ${product.flavors.join("/")}`).join("; ");

    if (body.offer && /^(yes|yeah|sure|okay|ok|add it|add them|please|sounds good)\b/i.test(text)) {
      const lines = body.offer.lines as Line[];
      if (!Array.isArray(lines) || lines.some(line => !byId.has(line.productId))) throw new PosError("That offer is no longer available.");
      await addMany(table, lines, requestId);
      const fresh = await state(table);
      return NextResponse.json({ message: "Done, those items are in your cart. Anything else?", state: fresh, suggestions: [] });
    }
    if (/^(no|no thanks|not now|skip|don't)\b/i.test(text) && body.offer) {
      return NextResponse.json({ message: "No problem. What else would you like?", state: current, suggestions: [] });
    }
    if (!text) throw new PosError("Say or type what you would like.");
    const normalized = text.toLowerCase();
    if (/\b(clear (my |the )?cart|cancel (my |the )?cart|start over)\b/.test(normalized)) {
      await clearCart(table);
      return NextResponse.json({ message: "Your cart is clear. What would you like to order?", state: await state(table), suggestions: [] });
    }
    if (/\b(confirm (my |the )?order|place (my |the )?order|make (my |the )?bill|that'?s all|finished ordering)\b/.test(normalized)) {
      const result = await confirmOrder(table);
      return NextResponse.json({ message: `Your order is confirmed for table ${table}. The bill is ${money(result.totalPaise)} and the kitchen has your ticket. Ask me for a Paytm QR when you’re ready to pay.`, state: await state(table), suggestions: [] });
    }
    if (/\b(check payment|payment status|is (it|my bill) paid)\b/.test(normalized)) {
      const order = current.orders.find(item => item.status !== "cancelled");
      if (!order) throw new PosError("Confirm an order first.");
      const result = await verifyPayment(order.id);
      return NextResponse.json({ message: result.paymentStatus === "paid" ? "Your payment is confirmed. Thank you!" : `Payment is ${result.paymentStatus}. I’ll keep checking.`, state: await state(table), suggestions: [] });
    }
    if (/\b(pay|payment|qr code|paytm qr|scan)\b/.test(normalized) && !/\b(what|how|can i)\b/.test(normalized)) {
      const order = current.orders.find(item => item.status !== "cancelled");
      if (!order) throw new PosError("Confirm an order first.");
      await createQr(order.id);
      return NextResponse.json({ message: `Your Paytm QR is on the bill for ${money(order.total_paise)}. Scan it with a UPI app; I’ll verify the payment.`, state: await state(table), suggestions: [] });
    }
    const lines = mentioned(normalized, products);
    if (!lines.length) {
      if (/^(no|no thanks|not now|skip)\b/.test(normalized)) {
        return NextResponse.json({ message: "Of course. Anything else I can get for you?", state: current, suggestions: [] });
      }
      const option = products.flatMap(product => product.options).find(value => normalized.includes(value.toLowerCase()));
      if (option) {
        const eligible = current.cart.filter(item => {
          const product = byId.get(item.product_id);
          return product?.options.includes(option) && !product.options.some(sauce => item.option_name.split(" · ").includes(sauce));
        });
        const target = eligible.find(item => item.product_id === body.optionTarget) ?? (eligible.length === 1 ? eligible[0] : null);
        if (target) {
          await setCartOption(table, target.product_id, option);
          return NextResponse.json({ message: `${option} for your ${target.name}, got it. Anything else?`, state: await state(table), suggestions: [] });
        }
        if (eligible.length > 1) {
          return NextResponse.json({ message: `Would you like ${option} with the ${eligible.map(item => item.name).join(" or ")}?`, state: current, suggestions: [] });
        }
      }
      const message = await menuAnswer(text, facts);
      return NextResponse.json({ message, state: current, suggestions: [] });
    }
    if (/\b(remove|delete|take off|cancel)\b/.test(normalized)) {
      for (const line of lines) {
        const matching = current.cart.filter(item => item.product_id === line.productId);
        const optionName = line.optionName || (matching.length === 1 ? matching[0].option_name : "");
        const quantity = /\ball\b/.test(normalized) && matching.length === 1 ? matching[0].quantity : line.quantity;
        await changeCart(table, line.productId, -quantity, optionName, requestId ? `${requestId}-${line.productId}` : "");
      }
      return NextResponse.json({ message: "I’ve updated your cart. Anything else?", state: await state(table), suggestions: [] });
    }
    if (/\b(make it|change (it|my order)|set (it|the quantity))\b/.test(normalized) && lines.length === 1) {
      const line = lines[0];
      const matching = current.cart.filter(item => item.product_id === line.productId);
      if (matching.length !== 1) throw new PosError("Tell Roy which flavor you want to change.");
      const delta = line.quantity - matching[0].quantity;
      if (delta) await changeCart(table, line.productId, delta, matching[0].option_name, requestId);
      return NextResponse.json({ message: `Updated ${matching[0].name} to ${line.quantity}. Anything else?`, state: await state(table), suggestions: [] });
    }

    const requested = lines.map(line => ({ ...line, quantity: Math.min(20, line.quantity) }));
    const short = requested.find(line => (byId.get(line.productId)?.stock ?? 0) < line.quantity);
    if (short) {
      const product = byId.get(short.productId)!;
      const available = product.stock;
      const other = product.substitutes.map(id => byId.get(id)).find(item => item && item.stock >= short.quantity - available);
      if (!other) {
        return NextResponse.json({ message: `I’m sorry, only ${available} ${product.name} available right now. Would you like something else?`, state: current, suggestions: [] });
      }
      const offerLines = requested.filter(line => line !== short);
      if (available > 0) offerLines.push({ ...short, quantity: available });
      offerLines.push({ productId: other.id, quantity: short.quantity - available });
      const total = offerLines.reduce((sum, line) => sum + byId.get(line.productId)!.price_paise * line.quantity, 0);
      const message = available > 0
        ? `Only ${available} ${product.name} is available. I can make that ${available} ${product.name} and ${short.quantity - available} ${other.name} for ${money(total)}. Would you like me to add those instead?`
        : `${product.name} is sold out. I can offer ${short.quantity} ${other.name} for ${money(total)} instead. Would you like me to add that?`;
      return NextResponse.json({ message, state: current, offer: { lines: offerLines, label: `Add suggested mix · ${money(total)}` }, suggestions: [] });
    }

    await addMany(table, requested, requestId);
    const fresh = await state(table);
    const first = byId.get(requested[0].productId)!;
    const declined = new Set(Array.isArray(body.declined) ? body.declined.map(String) : []);
    const suggestions = first.pairings.map(id => byId.get(id)).filter((item): item is Product => Boolean(item && item.stock > 0 && !declined.has(item.id))).slice(0, 2);
    const added = requested.map(line => `${line.quantity} ${byId.get(line.productId)!.name}${line.optionName ? ` with ${line.optionName}` : ""}`).join(" and ");
    const pitch = suggestions.length ? ` Would you like ${suggestions.map(item => `${item.name} (${money(item.price_paise)})`).join(" or ")} with it?` : " Anything else?";
    const sauce = first.options.length && !requested[0].optionName ? ` Which sauce would you prefer, ${first.options.join(" or ")}?` : "";
    const message = await naturalize(`Added ${added}.${pitch}${sauce}`, facts);
    return NextResponse.json({ message, state: fresh, optionTarget: first.options.length && !requested[0].optionName ? first.id : null, suggestions: suggestions.map(item => ({ id: item.id, name: item.name, pricePaise: item.price_paise })) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Roy could not process that." }, { status: error instanceof PosError ? error.status : 500 });
  }
}
