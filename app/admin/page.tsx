"use client";

import { useCallback, useEffect, useState } from "react";
import type { Order, Product } from "@/lib/types";

const rupees = (paise: number) => `₹${(paise / 100).toFixed(0)}`;
const when = (value: string) => new Date(value).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
type AdminState = { orders: Order[]; products: Product[] };
type Filter = "active" | "all" | "served";

async function action(body: object) {
  const response = await fetch("/api/admin", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Update failed.");
}

function ProductRow({ product, onSave }: { product: Product; onSave: (id: string, price: number, stock: number, active: boolean) => void }) {
  const [price, setPrice] = useState(product.price_paise / 100);
  const [stock, setStock] = useState(product.stock);
  const [active, setActive] = useState(product.active);
  useEffect(() => { setPrice(product.price_paise / 100); setStock(product.stock); setActive(product.active); }, [product]);
  return <div className="stock-row"><div><strong>{product.name}</strong><small>{product.category} · {product.stock ? `${product.stock} available` : "Sold out"}</small></div><label>₹ PRICE<input type="number" min="0" step="1" value={price} onChange={event => setPrice(Number(event.target.value))}/></label><label>STOCK<input type="number" min="0" step="1" value={stock} onChange={event => setStock(Number(event.target.value))}/></label><label>LIVE<input type="checkbox" checked={active} onChange={event => setActive(event.target.checked)}/></label><button onClick={() => onSave(product.id, Math.round(price * 100), stock, active)}>Save</button></div>;
}

export default function AdminPage() {
  const [data, setData] = useState<AdminState | null>(null);
  const [filter, setFilter] = useState<Filter>("active");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/admin", { cache: "no-store" });
      if (!response.ok) throw new Error("Could not load the dashboard. Check PostgreSQL.");
      setData(await response.json()); setError("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Dashboard unavailable."); }
  }, []);
  useEffect(() => { refresh(); const timer = window.setInterval(refresh, 3500); return () => window.clearInterval(timer); }, [refresh]);
  const update = async (body: object) => {
    setBusy(true); setError("");
    try { await action(body); await refresh(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Update failed."); }
    finally { setBusy(false); }
  };
  const orders = data?.orders ?? [];
  const active = orders.filter(order => !["served", "cancelled"].includes(order.status));
  const visible = filter === "active" ? active : filter === "served" ? orders.filter(order => order.status === "served") : orders;
  const revenue = orders.filter(order => order.payment_status === "paid").reduce((sum, order) => sum + order.total_paise, 0);
  return <main className="app-shell admin-shell">
    <header className="topbar"><div className="brand"><span className="brand-mark">C</span><span><strong>CounterCloser<span className="brand-ai">AI</span></strong><small>STAFF DESK · LOCAL DEMO</small></span></div><div className="top-actions"><span className="live-dot"/> Kitchen & merchant <span className="top-divider"/><a href="/">Customer view ↗</a></div></header>
    <div className="page-heading admin-heading"><div><p className="eyebrow">SERVICE CONTROL</p><h1>Every table, one clear view.</h1><p className="muted">Confirmed orders arrive here with items, table number, preparation, and payment state.</p></div></div>
    {error && <div className="notice error" role="alert">{error}<button onClick={() => setError("")}>×</button></div>}
    <div className="metric-row"><div className="metric"><small>Open tickets</small><strong>{active.length}</strong></div><div className="metric"><small>Preparing</small><strong>{orders.filter(order => order.status === "preparing").length}</strong></div><div className="metric"><small>Verified paid</small><strong>{rupees(revenue)}</strong></div></div>
    <div className="admin-grid"><div><section className="admin-card"><p className="eyebrow">KITCHEN QUEUE</p><h2>Orders to make</h2><div className="admin-tabs"><button className={filter === "active" ? "active" : ""} onClick={() => setFilter("active")}>Active</button><button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>All</button><button className={filter === "served" ? "active" : ""} onClick={() => setFilter("served")}>Served</button></div>{visible.length ? visible.map(order => <article className="ticket" key={order.id}><div className="ticket-top"><div><strong>Table {order.table_no}</strong><small>#{order.id.slice(0, 8)} · {when(order.created_at)}</small></div><span className="ticket-state">{order.status}</span></div><div className="ticket-items">{order.items.map((item, index) => <div key={`${item.product_id}-${index}`}>{item.quantity} × {item.name}{item.option_name ? ` · ${item.option_name}` : ""}</div>)}</div><div className="ticket-bottom"><span>Payment <b>{order.payment_status}</b></span><strong>{rupees(order.total_paise)}</strong></div><div className="ticket-actions">{order.status === "new" && <button disabled={busy} onClick={() => update({ action: "order", id: order.id, status: "preparing" })}>Start preparing →</button>}{order.status === "preparing" && <button disabled={busy} onClick={() => update({ action: "order", id: order.id, status: "ready" })}>Mark ready →</button>}{order.status === "ready" && <button disabled={busy} onClick={() => update({ action: "order", id: order.id, status: "served" })}>Mark served →</button>}{order.status === "new" && order.payment_status !== "paid" && <button className="danger" disabled={busy} onClick={() => update({ action: "cancel", id: order.id })}>Cancel & release stock</button>}</div></article>) : <p className="empty-note">No orders in this view. Confirm one from a customer table and it will appear here.</p>}</section></div>
      <aside><section className="admin-card"><p className="eyebrow">MERCHANT CATALOG</p><h2>Menu & availability</h2><p className="muted" style={{ fontSize: 11, marginTop: -8, marginBottom: 11 }}>Available stock changes immediately on all tables. Prices are locked into cart lines when added.</p>{data?.products.map(product => <ProductRow key={product.id} product={product} onSave={(id, pricePaise, stock, available) => update({ action: "product", id, pricePaise, stock, active: available })}/>)}</section><section className="admin-card"><p className="eyebrow">SERVICE NOTE</p><h2>Local demo controls</h2><p className="muted" style={{ fontSize: 12, lineHeight: 1.6 }}>This dashboard has no login by request. Run the app on localhost only. Paytm payments are marked paid only after a verified server-side transaction status.</p></section></aside></div>
    <footer className="footer">COUNTERCLOSER AI <span>·</span> KITCHEN, COUNTER & MERCHANT</footer>
  </main>;
}
