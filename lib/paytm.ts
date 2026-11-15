import PaytmChecksum from "paytmchecksum";
import { db, transaction } from "./db";
import { PosError } from "./pos";

export const paymentConfigured = () => Boolean(process.env.PAYTM_MID && process.env.PAYTM_MERCHANT_KEY && process.env.PAYTM_POS_ID);
const money = (paise: number) => (paise / 100).toFixed(2);

function ensureConfigured() {
  if (!paymentConfigured()) throw new PosError("Add Paytm merchant credentials to .env to enable live QR payments.", 503);
  if ((process.env.PAYTM_ENV || "staging") !== "staging") throw new PosError("Only Paytm staging is configured in this demo.", 503);
}

async function paytmCall(url: string, body: object, includeClientId = false) {
  const key = process.env.PAYTM_MERCHANT_KEY!;
  const signature = await PaytmChecksum.generateSignature(JSON.stringify(body), key);
  const head = { signature, ...(includeClientId ? { version: "v1", ...(process.env.PAYTM_CLIENT_ID ? { clientId: process.env.PAYTM_CLIENT_ID } : {}) } : {}) };
  const response = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body, head }), signal: AbortSignal.timeout(12000), cache: "no-store"
  });
  if (!response.ok) throw new PosError("Paytm is temporarily unavailable.", 502);
  const payload = await response.json();
  if (!payload?.body || !payload?.head?.signature ||
      !(await PaytmChecksum.verifySignature(JSON.stringify(payload.body), key, payload.head.signature))) {
    throw new PosError("Paytm response could not be verified.", 502);
  }
  return payload.body;
}

export async function createQr(orderId: string) {
  ensureConfigured();
  if (!/^[0-9a-f-]{36}$/.test(orderId)) throw new PosError("Invalid order ID.");
  return transaction(async client => {
    const result = await client.query("SELECT * FROM orders WHERE id=$1 FOR UPDATE", [orderId]);
    const order = result.rows[0];
    if (!order || order.status === "cancelled") throw new PosError("Confirmed order not found.", 404);
    if (order.qr_image) return { qrImage: order.qr_image, paymentStatus: order.payment_status };
    const body = {
      mid: process.env.PAYTM_MID!, orderId, amount: money(order.total_paise),
      businessType: "UPI_QR_CODE", posId: process.env.PAYTM_POS_ID!, imageRequired: true
    };
    const answer = await paytmCall("https://securegw-stage.paytmpayments.in/paymentservices/qr/create", body, true);
    if (answer.resultInfo?.resultStatus !== "SUCCESS" || typeof answer.image !== "string" ||
        !/^[A-Za-z0-9+/=]+$/.test(answer.image) || answer.image.length > 150000) {
      throw new PosError(answer.resultInfo?.resultMsg || "Paytm did not create a QR.", 502);
    }
    const image = `data:image/png;base64,${answer.image}`;
    await client.query("UPDATE orders SET qr_image=$2,payment_status='pending' WHERE id=$1", [orderId, image]);
    return { qrImage: image, paymentStatus: "pending" };
  });
}

export async function verifyPayment(orderId: string) {
  ensureConfigured();
  if (!/^[0-9a-f-]{36}$/.test(orderId)) throw new PosError("Invalid order ID.");
  const result = await (await db()).query("SELECT * FROM orders WHERE id=$1", [orderId]);
  const order = result.rows[0];
  if (!order || order.status === "cancelled" || !order.qr_image) throw new PosError("Payment request not found.", 404);
  if (order.payment_status === "paid") return { paymentStatus: "paid" };
  const answer = await paytmCall("https://securestage.paytmpayments.com/v3/order/status", { mid: process.env.PAYTM_MID!, orderId });
  const status = answer.resultInfo?.resultStatus;
  if (status === "TXN_SUCCESS") {
    if (answer.orderId !== orderId || Number(answer.txnAmount) !== order.total_paise / 100) {
      throw new PosError("Paytm amount or order ID did not match the bill.", 502);
    }
    await (await db()).query("UPDATE orders SET payment_status='paid' WHERE id=$1 AND payment_status<>'paid'", [orderId]);
    return { paymentStatus: "paid" };
  }
  const paymentStatus = status === "TXN_FAILURE" ? "failed" : "pending";
  await (await db()).query("UPDATE orders SET payment_status=$2 WHERE id=$1 AND payment_status<>'paid'", [orderId, paymentStatus]);
  return { paymentStatus };
}
