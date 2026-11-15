import PaytmChecksum from "paytmchecksum";
import { db, transaction } from "./db";
import { PosError } from "./pos";

export const paymentConfigured = () => Boolean(process.env.PAYTM_MID && process.env.PAYTM_MERCHANT_KEY && process.env.PAYTM_POS_ID);
const money = (paise: number) => (paise / 100).toFixed(2);

function ensureConfigured() {
  if (!paymentConfigured()) throw new PosError("Add Paytm merchant credentials to .env to enable live payments.", 503);
  if ((process.env.PAYTM_ENV || "staging") !== "staging") throw new PosError("Only Paytm staging is configured in this demo.", 503);
}

async function paytmCall(url: string, body: object, headFields: Record<string, string> = {}, requireSignature = true) {
  const key = process.env.PAYTM_MERCHANT_KEY!;
  const signature = await PaytmChecksum.generateSignature(JSON.stringify(body), key);
  const head = { signature, ...headFields, ...(process.env.PAYTM_CLIENT_ID ? { clientId: process.env.PAYTM_CLIENT_ID } : {}) };
  const response = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body, head }), signal: AbortSignal.timeout(12000), cache: "no-store"
  });
  if (!response.ok) throw new PosError("Paytm is temporarily unavailable.", 502);
  const payload = await response.json();
  if (!payload?.body || (requireSignature && !payload?.head?.signature) ||
      (payload?.head?.signature && !(await PaytmChecksum.verifySignature(JSON.stringify(payload.body), key, payload.head.signature)))) {
    throw new PosError("Paytm response could not be verified.", 502);
  }
  return payload.body;
}

function paymentResult(order: { qr_image: string | null; payment_link_url: string | null; payment_status: string }) {
  return { qrImage: order.qr_image, paymentLinkUrl: order.payment_link_url, paymentStatus: order.payment_status };
}

function validLink(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password &&
      ["paytm.me", "paytm.com", "paytmpayments.com", "p-y.tm"].some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`));
  } catch { return false; }
}

export async function createPayment(orderId: string) {
  ensureConfigured();
  if (!/^[0-9a-f-]{36}$/.test(orderId)) throw new PosError("Invalid order ID.");
  return transaction(async client => {
    const result = await client.query("SELECT * FROM orders WHERE id=$1 FOR UPDATE", [orderId]);
    const order = result.rows[0];
    if (!order || order.status === "cancelled") throw new PosError("Confirmed order not found.", 404);
    if (order.qr_image || order.payment_link_url) return paymentResult(order);
    const body = {
      mid: process.env.PAYTM_MID!, orderId, amount: money(order.total_paise),
      businessType: "UPI_QR_CODE", posId: process.env.PAYTM_POS_ID!, imageRequired: true
    };
    const answer = await paytmCall("https://securegw-stage.paytmpayments.in/paymentservices/qr/create", body, { version: "v1" });
    if (answer.resultInfo?.resultStatus === "SUCCESS") {
      if (typeof answer.image !== "string" || !/^[A-Za-z0-9+/=]+$/.test(answer.image) || answer.image.length > 150000) {
        throw new PosError("Paytm returned an invalid QR image.", 502);
      }
      const image = `data:image/png;base64,${answer.image}`;
      await client.query("UPDATE orders SET qr_image=$2,payment_method='qr',payment_status='pending' WHERE id=$1", [orderId, image]);
      return { qrImage: image, paymentLinkUrl: null, paymentStatus: "pending" };
    }
    // Only a definite QR capability denial permits another payment instrument.
    if (!["DQR_0004", "DQR_0007"].includes(answer.resultInfo?.resultCode)) {
      throw new PosError(answer.resultInfo?.resultMsg || "Paytm did not create a QR.", 502);
    }
    const link = await paytmCall("https://securestage.paytmpayments.com/link/create", {
      mid: process.env.PAYTM_MID!, merchantRequestId: orderId,
      linkOrderId: orderId.replaceAll("-", ""), linkName: `Cafe bill ${orderId.slice(0, 8)}`,
      linkDescription: "Cafe order payment", linkType: "FIXED", amount: Number(money(order.total_paise)),
      sendSms: false, sendEmail: false, maxPaymentsAllowed: "1", singleTransactionOnly: true,
      bindLinkIdMobile: false
    }, { tokenType: "AES" }, false);
    const linkId = String(link.linkId ?? "");
    if (link.resultInfo?.resultStatus !== "SUCCESS" || !/^\d+$/.test(linkId) ||
        !validLink(link.shortUrl) || Number(link.amount) !== order.total_paise / 100 ||
        (link.merchantRequestId && link.merchantRequestId !== orderId)) {
      throw new PosError(link.resultInfo?.resultMessage || "Paytm did not create a valid payment link.", 502);
    }
    await client.query("UPDATE orders SET payment_method='link',payment_link_id=$2,payment_link_url=$3,payment_status='pending' WHERE id=$1", [orderId, linkId, link.shortUrl]);
    return { qrImage: null, paymentLinkUrl: link.shortUrl, paymentStatus: "pending" };
  });
}

export async function verifyPayment(orderId: string) {
  ensureConfigured();
  if (!/^[0-9a-f-]{36}$/.test(orderId)) throw new PosError("Invalid order ID.");
  const result = await (await db()).query("SELECT * FROM orders WHERE id=$1", [orderId]);
  const order = result.rows[0];
  if (!order || order.status === "cancelled" || (!order.qr_image && !order.payment_link_id)) throw new PosError("Payment request not found.", 404);
  if (order.payment_status === "paid") return { paymentStatus: "paid" };
  let paytmOrderId = orderId;
  if (order.payment_link_id) {
    const transactions = await paytmCall("https://securestage.paytmpayments.com/link/fetchTransaction", {
      mid: process.env.PAYTM_MID!, linkId: order.payment_link_id, fetchAllTxns: true
    }, { tokenType: "AES" });
    if (transactions.resultInfo?.resultStatus !== "SUCCESS") throw new PosError("Paytm could not fetch link transactions.", 502);
    const entries = Array.isArray(transactions.orders) ? transactions.orders : transactions.orders ? [transactions.orders] : [];
    const candidate = entries.find((entry: { orderId?: string; txnAmount?: number; mercUniqRef?: string }) =>
      typeof entry.orderId === "string" && entry.orderId.length > 0 && entry.orderId.length <= 64 &&
      Number(entry.txnAmount) === order.total_paise / 100 &&
      (!entry.mercUniqRef || entry.mercUniqRef === order.payment_link_id));
    if (!candidate) return { paymentStatus: "pending" };
    paytmOrderId = candidate.orderId;
  }
  const answer = await paytmCall("https://securestage.paytmpayments.com/v3/order/status", { mid: process.env.PAYTM_MID!, orderId: paytmOrderId });
  const status = answer.resultInfo?.resultStatus;
  if (status === "TXN_SUCCESS") {
    if (answer.orderId !== paytmOrderId || Number(answer.txnAmount) !== order.total_paise / 100) {
      throw new PosError("Paytm amount or order ID did not match the bill.", 502);
    }
    await (await db()).query("UPDATE orders SET payment_status='paid' WHERE id=$1 AND payment_status<>'paid'", [orderId]);
    return { paymentStatus: "paid" };
  }
  const paymentStatus = status === "TXN_FAILURE" ? "failed" : "pending";
  await (await db()).query("UPDATE orders SET payment_status=$2 WHERE id=$1 AND payment_status<>'paid'", [orderId, paymentStatus]);
  return { paymentStatus };
}
