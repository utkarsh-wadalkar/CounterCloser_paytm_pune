"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PosState } from "@/lib/types";

type Transcript = { speaker: "Customer" | "Roy"; text: string; time: string };
type Offer = { lines: { productId: string; quantity: number; optionName?: string }[]; label: string };
type Suggestion = { id: string; name: string; pricePaise: number };
type VoiceConfig = { configured: boolean; appId: string | null; orgId: string | null; workspaceId: string | null };
type Agent = { start(): Promise<void>; stop(): Promise<void> };

const rupees = (paise: number) => `₹${(paise / 100).toFixed(0)}`;
const now = () => new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });

async function post(url: string, body: object) {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed.");
  return data;
}

export default function CustomerPage() {
  const [table, setTable] = useState(1);
  const [snapshot, setSnapshot] = useState<PosState | null>(null);
  const [voiceConfig, setVoiceConfig] = useState<VoiceConfig | null>(null);
  const [voiceStatus, setVoiceStatus] = useState("off");
  const [messages, setMessages] = useState<Transcript[]>([{ speaker: "Roy", text: "Welcome in. I’m Roy. Tell me what you’re craving, and I’ll put your order together.", time: now() }]);
  const [input, setInput] = useState("");
  const [offer, setOffer] = useState<Offer | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [optionTarget, setOptionTarget] = useState<string | null>(null);
  const [declined, setDeclined] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const agentRef = useRef<Agent | null>(null);
  const seenTranscripts = useRef(new Set<string>());
  const sessionId = useRef("");
  const offerRef = useRef<Offer | null>(null);
  const optionTargetRef = useRef<string | null>(null);
  const declinedRef = useRef<string[]>([]);

  const refresh = useCallback(async (activeTable: number) => {
    try {
      const response = await fetch(`/api/pos?table=${activeTable}`, { cache: "no-store" });
      if (!response.ok) throw new Error("Could not load the POS. Check PostgreSQL.");
      setSnapshot(await response.json());
      setError("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not load the POS."); }
  }, []);

  useEffect(() => {
    const parameter = Number(new URLSearchParams(window.location.search).get("table"));
    if (Number.isInteger(parameter) && parameter >= 1 && parameter <= 50) setTable(parameter);
    sessionId.current = crypto.randomUUID();
    fetch("/api/voice").then(response => response.json()).then(setVoiceConfig).catch(() => {});
  }, []);
  useEffect(() => {
    refresh(table);
    const timer = window.setInterval(() => refresh(table), 3500);
    return () => window.clearInterval(timer);
  }, [table, refresh]);
  useEffect(() => () => { void agentRef.current?.stop(); }, []);
  useEffect(() => { offerRef.current = offer; optionTargetRef.current = optionTarget; declinedRef.current = declined; }, [offer, optionTarget, declined]);

  const addMessage = (speaker: Transcript["speaker"], text: string) =>
    setMessages(previous => [...previous.slice(-15), { speaker, text, time: now() }]);

  const sendRoy = async (utterance: string, pendingOffer: Offer | null = offerRef.current, requestId = crypto.randomUUID()) => {
    setBusy(true); setError("");
    addMessage("Customer", utterance);
    try {
      const answer = await post("/api/roy", { table, text: utterance, offer: pendingOffer, declined: declinedRef.current, optionTarget: optionTargetRef.current, requestId });
      setSnapshot(answer.state);
      setOffer(answer.offer ?? null);
      setSuggestions(answer.suggestions ?? []);
      setOptionTarget(answer.optionTarget ?? null);
      if (/^(no|no thanks|not now|skip)\b/i.test(utterance) && suggestions.length) {
        setDeclined(previous => [...previous, ...suggestions.map(item => item.id)]);
      }
      addMessage("Roy", answer.message);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Roy could not process that."); }
    finally { setBusy(false); }
  };

  const selectTable = (value: number) => {
    if (!Number.isInteger(value) || value < 1 || value > 50) return;
    void agentRef.current?.stop(); agentRef.current = null; setVoiceStatus("off");
    setTable(value); setOffer(null); setSuggestions([]); setOptionTarget(null); setMessages([{ speaker: "Roy", text: `Table ${value} is ready. What can I get you?`, time: now() }]);
    window.history.replaceState({}, "", `/?table=${value}`);
  };

  const toggleVoice = async () => {
    if (agentRef.current) {
      await agentRef.current.stop(); agentRef.current = null; setVoiceStatus("off"); return;
    }
    if (!voiceConfig?.configured) { setError("Add Sarvam Voice Agent credentials to .env and restart the app to enable live calling."); return; }
    setVoiceStatus("connecting"); setError("");
    try {
      const { ConversationAgent, BrowserAudioInterface, InteractionType } = await import("sarvam-conv-ai-sdk/browser");
      const agent = new ConversationAgent({
        apiKey: "",
        baseUrl: `${window.location.origin}/api/sarvam/`,
        platform: "browser",
        audioInterface: new BrowserAudioInterface(16000),
        config: {
          org_id: voiceConfig.orgId!, workspace_id: voiceConfig.workspaceId!, app_id: voiceConfig.appId!,
          user_identifier_type: "custom", user_identifier: `${sessionId.current}-table-${table}`,
          interaction_type: InteractionType.CALL, input_sample_rate: 16000, output_sample_rate: 22050,
          agent_variables: { table_number: table, catalog: snapshot?.products.filter(item => item.active).map(item => `${item.name}: ${rupees(item.price_paise)}, ${item.stock} available`).join("; ") ?? "" }
        },
        startCallback: async () => setVoiceStatus("live"),
        endCallback: async () => { agentRef.current = null; setVoiceStatus("off"); },
        transcriptCallback: async message => {
          if (!message.content?.trim()) return;
          if (message.role === "bot") { addMessage("Roy", message.content); return; }
          const id = `${message.timestamp}:${message.content}`;
          if (seenTranscripts.current.has(id)) return;
          seenTranscripts.current.add(id);
          if (seenTranscripts.current.size > 100) seenTranscripts.current.clear();
          await sendRoy(message.content, offerRef.current, `${sessionId.current}-${message.timestamp}`);
        }
      });
      agentRef.current = agent;
      await agent.start();
    } catch (reason) {
      agentRef.current = null; setVoiceStatus("off");
      setError(reason instanceof Error ? reason.message : "Microphone or voice connection failed.");
    }
  };

  const cart = snapshot?.cart ?? [];
  const total = cart.reduce((sum, item) => sum + item.unit_price_paise * item.quantity, 0);
  const activeOrder = snapshot?.orders.find(order => order.status !== "cancelled");
  useEffect(() => {
    if (!activeOrder?.qr_image || activeOrder.payment_status === "paid") return;
    const timer = window.setInterval(async () => {
      try { await post("/api/payment", { action: "verify", orderId: activeOrder.id }); await refresh(table); }
      catch { /* The visible status remains pending until a verified result arrives. */ }
    }, 10000);
    return () => window.clearInterval(timer);
  }, [activeOrder?.id, activeOrder?.qr_image, activeOrder?.payment_status, table, refresh]);
  const products = (snapshot?.products ?? []).filter(item => item.name.toLowerCase().includes(search.toLowerCase()));
  const categories = [...new Set(products.map(item => item.category))];

  return <main className="app-shell customer-shell">
    <header className="topbar">
      <div className="brand"><span className="brand-mark">C</span><span><strong>CounterCloser<span className="brand-ai">AI</span></strong><small>CAFÉ POS · LOCAL DEMO</small></span></div>
      <div className="top-actions"><span className="live-dot"/> Live counter <span className="top-divider"/> <a href="/admin">Staff dashboard ↗</a></div>
    </header>
    <div className="page-heading"><div><p className="eyebrow">THE FRONT COUNTER</p><h1>Good food. Faster service.</h1><p className="muted">Roy takes the order while your cart, stock, and bill stay in sync.</p></div><div className="table-picker"><label htmlFor="table">TABLE NUMBER</label><div><span>◫</span><input id="table" aria-label="Table number" type="number" min="1" max="50" value={table} onChange={event => selectTable(Number(event.target.value))}/><span className="table-chevron">⌄</span></div></div></div>
    {error && <div className="notice error" role="alert">{error}<button onClick={() => setError("")}>×</button></div>}
    <div className="customer-grid">
      <section className="menu-section"><div className="section-heading"><div><p className="eyebrow">EXPLORE THE MENU</p><h2>Something for everyone</h2></div><span className="count-tag">{snapshot?.products.length ?? 0} items</span></div><div className="search-wrap"><span>⌕</span><input placeholder="Search the menu..." value={search} onChange={event => setSearch(event.target.value)}/></div>
        {categories.map(category => <details key={category} className="catalog-category" open>
          <summary><span>{category}</span><small>{products.filter(item => item.category === category).length} choices</small></summary>
          <div className="catalog-column-head"><span>ITEM / FLAVORS</span><span>PRICE</span></div>
          <ul className="catalog-list">{products.filter(item => item.category === category).map(product => <li key={product.id}><details className="catalog-item">
            <summary><span className="catalog-bullet">•</span><strong>{product.name}</strong><span className="catalog-price">{rupees(product.price_paise)}</span><span className="catalog-arrow">⌄</span></summary>
            <div className="catalog-detail"><span>FLAVORS</span><ul>{product.flavors.map(flavor => <li key={flavor}>{flavor}</li>)}</ul>{product.options.length > 0 && <p>Sauces: {product.options.join(" · ")}</p>}</div>
          </details></li>)}</ul>
        </details>)}
        {!products.length && <p className="empty-note">No items match that search.</p>}
      </section>
      <aside className="right-rail">
        <section className="panel roy-panel">
          <div className="panel-heading"><div className="roy-avatar">R<span/></div><div><h3>Roy, your waiter</h3><p>{voiceStatus === "live" ? "Listening live" : voiceStatus === "connecting" ? "Connecting…" : "Here to help you order"}</p></div><span className={`status-chip ${voiceStatus === "live" ? "status-live" : ""}`}>{voiceStatus === "live" ? "LIVE" : "READY"}</span></div>
          <div className="conversation" aria-live="polite">{messages.map((message, index) => <div className={`message ${message.speaker === "Customer" ? "customer-message" : "roy-message"}`} key={`${index}-${message.time}`}><div className="message-meta"><strong>{message.speaker}</strong><time>{message.time}</time></div><p>{message.text}</p></div>)}</div>
          {offer && <div className="offer-card"><p>Roy suggests: {offer.label}</p><small>Say or type “yes” to accept, or “no thanks” to decline.</small></div>}
          {suggestions.length > 0 && <div className="suggestion-row">{suggestions.map(item => <span key={item.id}>{item.name} · {rupees(item.pricePaise)}</span>)}<small>Tell Roy what you prefer.</small></div>}
          <form className="chat-form" onSubmit={event => { event.preventDefault(); if (input.trim()) { void sendRoy(input.trim()); setInput(""); } }}><input aria-label="Message Roy" placeholder="Try ‘one burger and fries’" value={input} onChange={event => setInput(event.target.value)} disabled={busy}/><button type="submit" disabled={busy || !input.trim()} aria-label="Send message">↑</button></form>
          <div className="voice-control"><button className={`voice-button ${voiceStatus === "live" ? "recording" : ""}`} onClick={() => void toggleVoice()} disabled={voiceStatus === "connecting"}><span>◉</span>{voiceStatus === "live" ? "End live call" : "Talk to Roy"}</button><span>{voiceConfig?.configured ? "Microphone + speaker" : "Voice setup needed"}</span></div>
        </section>
        <section className="panel cart-panel"><div className="cart-heading"><div><p className="eyebrow">YOUR ORDER</p><h3>Table {table} bill</h3></div><span className="count-tag">{cart.reduce((sum, item) => sum + item.quantity, 0)} items</span></div>{cart.length ? <div className="cart-lines">{cart.map(item => <div className="cart-line" key={`${item.product_id}-${item.option_name}`}><div><strong>{item.name}</strong><small>{item.option_name || "Standard"}</small></div><span className="cart-quantity">× {item.quantity}</span><strong>{rupees(item.quantity * item.unit_price_paise)}</strong></div>)}</div> : <div className="empty-cart"><span>◇</span><p>Your cart is waiting.</p><small>Tell Roy what you would like from the menu.</small></div>}<div className="bill-total"><span>Subtotal</span><strong>{rupees(total)}</strong></div><p className="cart-hint">Ask Roy to change an item, clear the cart, or confirm your order.</p></section>
        {activeOrder && <section className="panel receipt-panel"><p className="eyebrow">LATEST ORDER</p><div className="receipt-heading"><strong>Bill #{activeOrder.id.slice(0, 8)}</strong><span className="status-chip">{activeOrder.status}</span></div><div className="receipt-lines">{activeOrder.items.map((item, index) => <div key={`${item.product_id}-${index}`}><span>{item.quantity} × {item.name}{item.option_name ? ` · ${item.option_name}` : ""}</span><strong>{rupees(item.quantity * item.unit_price_paise)}</strong></div>)}</div><div className="bill-total"><span>Total due</span><strong>{rupees(activeOrder.total_paise)}</strong></div><p className="payment-state">Payment: <b>{activeOrder.payment_status}</b></p>{activeOrder.qr_image ? <div className="qr-wrap"><img src={activeOrder.qr_image} alt="Paytm QR for this bill" width="180" height="180"/><small>Scan with a UPI app. Roy checks payment automatically.</small></div> : <p className="cart-hint">Ask Roy for a Paytm QR to pay this bill.</p>}</section>}
      </aside>
    </div>
    <footer className="footer">COUNTERCLOSER AI <span>·</span> MADE FOR THE MOMENT AT THE COUNTER <span>·</span> LOCAL CAFÉ DEMO</footer>
  </main>;
}
