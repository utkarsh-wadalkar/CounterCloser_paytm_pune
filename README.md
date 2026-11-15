# CounterCloser AI

A local café POS with a customer ordering page at `/` and a kitchen/merchant dashboard at `/admin`. The customer catalog is a read-only list with flavor drop downs and a price column. Roy handles every cart action through voice or text, suggests catalogued add-ons and in-stock substitutes, confirms the bill, and can create a Paytm QR or payment link. A configured Sarvam Voice Agent uses the browser microphone and speaker.

## Run locally

Requires Node.js, npm, and Docker Desktop. The app binds to `127.0.0.1`; the PostgreSQL container is bound to `127.0.0.1:55432` so it does not touch other projects' databases.

1. Copy `.env.example` to `.env`. Generate a local password and set both `POSTGRES_PASSWORD` and `DATABASE_URL` (`postgresql://countercloser:<password>@127.0.0.1:55432/countercloser`). Keep `.env` out of Git.
2. Run `docker compose up -d db`.
3. Run `npm install` and `npm run dev`.
4. Open [customer POS](http://127.0.0.1:3000/?table=1) and [staff dashboard](http://127.0.0.1:3000/admin). Use `?table=2` in another tab to exercise two tables.

The current local `.env` already has the PostgreSQL connection, the standard Sarvam model key, and the organization/workspace IDs. Do not paste any keys into chat, source code, or Git.

## Environment variables

| Variable | Purpose | Needed now? |
| --- | --- | --- |
| `DATABASE_URL`, `POSTGRES_PASSWORD` | Isolated local PostgreSQL | Yes; already configured locally |
| `SARVAM_API_KEY` | Roy's Sarvam chat model and the standalone `sarvam_chat.py` smoke test | Yes; already configured locally |
| `SARVAM_ORG_ID`, `SARVAM_WORKSPACE_ID` | Browser Voice Agent workspace | Already filled from the project plan |
| `SARVAM_VOICE_AGENT_API_KEY` | Separate Voice Agents key; kept server side by the signed URL proxy | Needed for live voice |
| `SARVAM_VOICE_APP_ID` | ID of a deployed browser-compatible Roy Voice Agent app | Needed for live voice |
| `PAYTM_MID`, `PAYTM_MERCHANT_KEY`, `PAYTM_POS_ID` | Paytm staging Dynamic QR, Payment Link fallback, and transaction status | Needed for live payment |
| `PAYTM_CLIENT_ID` | Paytm client ID when the merchant has more than one key | Account dependent |
| `PAYTM_ENV` | `staging` is the only supported setting here | Already defaults to staging |

The Voice Agent SDK handles live speech input and output, so it does not require separate STT or TTS keys in this browser path. The hosted Roy app should use its `table_number` and `catalog` variables, keep its menu claims grounded, and let the POS server validate every cart action. The browser receives a signed session URL from `/api/sarvam/.../url`; the Voice Agents key stays on the server. Restart `npm run dev` after adding credentials.

## Demo flow

- Cold coffee starts at one available unit and iced latte at six. Ask Roy for **two cold coffees**. Roy offers one of each for ₹170. Say **yes** and then **confirm my order**; the ticket appears at `/admin` with its table number.
- Order a **cheese burger**. Roy offers fries and a drink and asks about ketchup or mayonnaise. Accepted flavors, sauces, and items appear in the cart and bill. All synthetic flavors currently have the same base item price.
- The catalog editor changes available stock, price, and visibility. Cart lines hold the price from when each item was added.
- The kitchen advances a ticket from **new → preparing → ready → served**. A new order without a payment request can be cancelled, returning reserved stock.
- If Paytm staging credentials are present, ask Roy to **pay** after confirming. Roy first requests a Dynamic QR. If Paytm explicitly reports that UPI QR is disabled for the merchant, Roy creates a fixed-amount Payment Link instead. The bill becomes **paid** only after the server verifies Paytm's signed transaction status, order ID, and amount. Without credentials, the UI shows a setup error and never simulates payment.
- A draft cart untouched for 15 minutes expires and releases its stock the next time the POS checks for stale carts.

This is a localhost demo with synthetic menu data and no login, as requested. Live Voice Agent calling and Paytm payments cannot be exercised until those provider credentials and app access are present. The voice agent's hosted configuration is separate from this repository; keep its ordering behavior aligned with the current catalog.

See [architecture](ARCHITECTURE.md) and [plan](PLAN.md) for the system diagram and pitch flow.
