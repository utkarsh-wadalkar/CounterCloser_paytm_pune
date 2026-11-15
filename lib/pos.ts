import { randomUUID } from "node:crypto";
import { db, transaction } from "./db";

export class PosError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

let nextExpiryCheck = 0;
export async function expireStaleCarts() {
  if (Date.now() < nextExpiryCheck) return;
  nextExpiryCheck = Date.now() + 30_000;
  const database = await db();
  const stale = await database.query(
    "SELECT table_no FROM carts WHERE status='draft' AND updated_at < now() - interval '15 minutes' ORDER BY updated_at LIMIT 20"
  );
  for (const row of stale.rows) {
    await transaction(async client => {
      await client.query("SELECT pg_advisory_xact_lock(71243,$1)", [row.table_no]);
      const cart = await client.query(
        "SELECT id FROM carts WHERE table_no=$1 AND status='draft' AND updated_at < now() - interval '15 minutes' FOR UPDATE", [row.table_no]
      );
      if (!cart.rowCount) return;
      const items = await client.query("SELECT product_id,quantity FROM cart_items WHERE cart_id=$1", [cart.rows[0].id]);
      for (const item of items.rows) {
        await client.query("UPDATE products SET stock=stock+$1 WHERE id=$2", [item.quantity, item.product_id]);
      }
      await client.query("UPDATE carts SET status='cancelled' WHERE id=$1", [cart.rows[0].id]);
    });
  }
}

export function tableNumber(value: unknown): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 50) throw new PosError("Choose a table from 1 to 50.");
  return number;
}

function validOption(product: { flavors: string[]; options: string[] }, value: string) {
  if (!value) return true;
  const parts = value.split(" · ");
  return parts.length <= 2 && new Set(parts).size === parts.length &&
    parts.filter(part => product.flavors.includes(part)).length <= 1 &&
    parts.filter(part => product.options.includes(part)).length <= 1 &&
    parts.every(part => product.flavors.includes(part) || product.options.includes(part));
}

export async function state(table: number) {
  await expireStaleCarts();
  const database = await db();
  const [products, cart, orders, orderItems] = await Promise.all([
    database.query("SELECT * FROM products WHERE active ORDER BY category, name"),
    database.query(
      `SELECT c.id AS cart_id, ci.product_id, ci.option_name, ci.quantity, ci.unit_price_paise,
              p.name FROM carts c JOIN cart_items ci ON ci.cart_id = c.id JOIN products p ON p.id = ci.product_id
       WHERE c.table_no=$1 AND c.status='draft' ORDER BY p.name`, [table]
    ),
    database.query("SELECT * FROM orders WHERE table_no=$1 ORDER BY created_at DESC LIMIT 8", [table]),
    database.query("SELECT oi.* FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.table_no=$1 ORDER BY o.created_at DESC LIMIT 80", [table])
  ]);
  return { products: products.rows, cart: cart.rows, orders: orders.rows.map(order => ({ ...order, items: orderItems.rows.filter(item => item.order_id === order.id) })) };
}

export async function allOrders() {
  await expireStaleCarts();
  const database = await db();
  const [orders, items, products] = await Promise.all([
    database.query("SELECT * FROM orders ORDER BY created_at DESC LIMIT 100"),
    database.query("SELECT * FROM order_items WHERE order_id IN (SELECT id FROM orders ORDER BY created_at DESC LIMIT 100)"),
    database.query("SELECT * FROM products ORDER BY category,name")
  ]);
  return { orders: orders.rows.map(o => ({ ...o, items: items.rows.filter(i => i.order_id === o.id) })), products: products.rows };
}

export async function changeCart(table: number, productId: string, delta: number, optionName = "", requestId = "") {
  await expireStaleCarts();
  if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 20) throw new PosError("Choose 1 to 20 items.");
  return transaction(async client => {
    await client.query("SELECT pg_advisory_xact_lock(71243,$1)", [table]);
    if (requestId) {
      if (requestId.length > 120) throw new PosError("Invalid request ID.");
      const previous = await client.query("SELECT 1 FROM cart_mutations WHERE request_id=$1", [requestId]);
      if (previous.rowCount) return { ok: true, duplicate: true };
    }
    const productResult = await client.query("SELECT * FROM products WHERE id=$1 AND active FOR UPDATE", [productId]);
    const product = productResult.rows[0];
    if (!product) throw new PosError("Item is not on the menu.", 404);
    if (!validOption(product, optionName)) throw new PosError("This flavor or sauce is not available.");
    let cartResult = await client.query("SELECT * FROM carts WHERE table_no=$1 AND status='draft' FOR UPDATE", [table]);
    if (!cartResult.rowCount) {
      if (delta < 0) throw new PosError("The cart is empty.");
      cartResult = await client.query("INSERT INTO carts (id,table_no) VALUES ($1,$2) RETURNING *", [randomUUID(), table]);
    }
    const cartId = cartResult.rows[0].id;
    const existing = await client.query(
      "SELECT quantity FROM cart_items WHERE cart_id=$1 AND product_id=$2 AND option_name=$3 FOR UPDATE",
      [cartId, productId, optionName]
    );
    const next = (existing.rows[0]?.quantity ?? 0) + delta;
    if (next < 0) throw new PosError("That item is not in the cart.");
    if (delta > 0 && product.stock < delta) throw new PosError(`${product.name} has only ${product.stock} available.`, 409);
    await client.query("UPDATE products SET stock=stock-$1 WHERE id=$2", [delta, productId]);
    if (next === 0) {
      await client.query("DELETE FROM cart_items WHERE cart_id=$1 AND product_id=$2 AND option_name=$3", [cartId, productId, optionName]);
    } else {
      await client.query(
        `INSERT INTO cart_items (cart_id,product_id,option_name,quantity,unit_price_paise)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (cart_id,product_id,option_name) DO UPDATE SET quantity=$4`,
        [cartId, productId, optionName, next, product.price_paise]
      );
    }
    await client.query("UPDATE carts SET updated_at=now() WHERE id=$1", [cartId]);
    if (requestId) await client.query("INSERT INTO cart_mutations (request_id,table_no) VALUES ($1,$2)", [requestId, table]);
    return { ok: true };
  });
}

export async function addMany(table: number, lines: { productId: string; quantity: number; optionName?: string }[], requestId = "") {
  await expireStaleCarts();
  if (!Array.isArray(lines) || !lines.length || lines.length > 8 || lines.some(line => !line || typeof line.productId !== "string" || typeof line.optionName !== "undefined" && typeof line.optionName !== "string" || !Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > 20)) {
    throw new PosError("Choose valid quantities for up to eight items.");
  }
  if (new Set(lines.map(line => `${line.productId}:${line.optionName ?? ""}`)).size !== lines.length) {
    throw new PosError("Duplicate item in offer.");
  }
  return transaction(async client => {
    await client.query("SELECT pg_advisory_xact_lock(71243,$1)", [table]);
    if (requestId) {
      if (requestId.length > 120) throw new PosError("Invalid request ID.");
      const previous = await client.query("SELECT 1 FROM cart_mutations WHERE request_id=$1", [requestId]);
      if (previous.rowCount) return { ok: true, duplicate: true };
    }
    const sorted = [...lines].sort((a,b) => a.productId.localeCompare(b.productId));
    const products = new Map<string, { id: string; name: string; stock: number; flavors: string[]; options: string[]; price_paise: number }>();
    for (const line of sorted) {
      if (!products.has(line.productId)) {
        const result = await client.query("SELECT * FROM products WHERE id=$1 AND active FOR UPDATE", [line.productId]);
        if (!result.rowCount) throw new PosError("Item is not on the menu.", 404);
        products.set(line.productId, result.rows[0]);
      }
    }
    let cart = await client.query("SELECT id FROM carts WHERE table_no=$1 AND status='draft' FOR UPDATE", [table]);
    if (!cart.rowCount) cart = await client.query("INSERT INTO carts (id,table_no) VALUES ($1,$2) RETURNING id", [randomUUID(), table]);
    const cartId = cart.rows[0].id;
    for (const line of sorted) {
      const product = products.get(line.productId)!;
      const option = line.optionName ?? "";
      if (!validOption(product, option)) throw new PosError("This flavor or sauce is not available.");
      if (product.stock < line.quantity) throw new PosError(`${product.name} has only ${product.stock} available.`, 409);
      product.stock -= line.quantity;
      await client.query("UPDATE products SET stock=stock-$1 WHERE id=$2", [line.quantity, product.id]);
      await client.query(
        `INSERT INTO cart_items (cart_id,product_id,option_name,quantity,unit_price_paise) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (cart_id,product_id,option_name) DO UPDATE SET quantity=cart_items.quantity+$4`,
        [cartId, product.id, option, line.quantity, product.price_paise]
      );
    }
    await client.query("UPDATE carts SET updated_at=now() WHERE id=$1", [cartId]);
    if (requestId) await client.query("INSERT INTO cart_mutations (request_id,table_no) VALUES ($1,$2)", [requestId, table]);
    return { ok: true };
  });
}

export async function confirmOrder(table: number) {
  return transaction(async client => {
    await client.query("SELECT pg_advisory_xact_lock(71243,$1)", [table]);
    const cart = await client.query("SELECT * FROM carts WHERE table_no=$1 AND status='draft' FOR UPDATE", [table]);
    if (!cart.rowCount) throw new PosError("Add items before confirming the order.");
    const items = await client.query(
      "SELECT ci.*, p.name FROM cart_items ci JOIN products p ON p.id=ci.product_id WHERE ci.cart_id=$1",
      [cart.rows[0].id]
    );
    if (!items.rowCount) throw new PosError("Add items before confirming the order.");
    const total = items.rows.reduce((sum, item) => sum + item.quantity * item.unit_price_paise, 0);
    const id = randomUUID();
    await client.query("INSERT INTO orders (id,table_no,total_paise) VALUES ($1,$2,$3)", [id, table, total]);
    for (const item of items.rows) {
      await client.query(
        "INSERT INTO order_items (order_id,product_id,name,option_name,quantity,unit_price_paise) VALUES ($1,$2,$3,$4,$5,$6)",
        [id, item.product_id, item.name, item.option_name, item.quantity, item.unit_price_paise]
      );
    }
    await client.query("UPDATE carts SET status='confirmed' WHERE id=$1", [cart.rows[0].id]);
    return { orderId: id, totalPaise: total };
  });
}

export async function clearCart(table: number) {
  return transaction(async client => {
    await client.query("SELECT pg_advisory_xact_lock(71243,$1)", [table]);
    const cart = await client.query("SELECT id FROM carts WHERE table_no=$1 AND status='draft' FOR UPDATE", [table]);
    if (!cart.rowCount) return { ok: true };
    const items = await client.query("SELECT product_id,quantity FROM cart_items WHERE cart_id=$1", [cart.rows[0].id]);
    for (const item of items.rows) {
      await client.query("UPDATE products SET stock=stock+$1 WHERE id=$2", [item.quantity, item.product_id]);
    }
    await client.query("UPDATE carts SET status='cancelled' WHERE id=$1", [cart.rows[0].id]);
    return { ok: true };
  });
}

export async function setCartOption(table: number, productId: string, toOption: string) {
  return transaction(async client => {
    await client.query("SELECT pg_advisory_xact_lock(71243,$1)", [table]);
    const product = await client.query("SELECT options FROM products WHERE id=$1", [productId]);
    if (!product.rowCount || !product.rows[0].options.includes(toOption)) throw new PosError("That sauce is not available.");
    const cart = await client.query("SELECT id FROM carts WHERE table_no=$1 AND status='draft' FOR UPDATE", [table]);
    if (!cart.rowCount) throw new PosError("The cart is empty.");
    const lines = await client.query(
      "SELECT * FROM cart_items WHERE cart_id=$1 AND product_id=$2 FOR UPDATE", [cart.rows[0].id, productId]
    );
    const eligible = lines.rows.filter(line => !product.rows[0].options.some((option: string) => line.option_name.split(" · ").includes(option)));
    if (eligible.length !== 1) throw new PosError("Tell Roy which item should have that sauce.");
    const line = eligible[0];
    const newOption = [line.option_name, toOption].filter(Boolean).join(" · ");
    await client.query(
      `INSERT INTO cart_items (cart_id,product_id,option_name,quantity,unit_price_paise) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (cart_id,product_id,option_name) DO UPDATE SET quantity=cart_items.quantity+$4`,
      [cart.rows[0].id, productId, newOption, line.quantity, line.unit_price_paise]
    );
    await client.query("DELETE FROM cart_items WHERE cart_id=$1 AND product_id=$2 AND option_name=$3", [cart.rows[0].id, productId, line.option_name]);
    await client.query("UPDATE carts SET updated_at=now() WHERE id=$1", [cart.rows[0].id]);
    return { ok: true };
  });
}

export async function cancelOrder(id: string) {
  return transaction(async client => {
    const order = await client.query("SELECT * FROM orders WHERE id=$1 FOR UPDATE", [id]);
    if (!order.rowCount) throw new PosError("Order not found.", 404);
    if (order.rows[0].status !== "new" || order.rows[0].payment_status !== "unpaid" || order.rows[0].qr_image) {
      throw new PosError("Only a new order without a payment request can be cancelled.", 409);
    }
    const items = await client.query("SELECT product_id,quantity FROM order_items WHERE order_id=$1", [id]);
    for (const item of items.rows) {
      await client.query("UPDATE products SET stock=stock+$1 WHERE id=$2", [item.quantity, item.product_id]);
    }
    await client.query("UPDATE orders SET status='cancelled' WHERE id=$1", [id]);
    return { ok: true };
  });
}

export async function setOrderStatus(id: string, status: string) {
  if (!["preparing", "ready", "served"].includes(status)) throw new PosError("Invalid kitchen status.");
  const prior = { preparing: "new", ready: "preparing", served: "ready" }[status as "preparing" | "ready" | "served"];
  const result = await (await db()).query(
    "UPDATE orders SET status=$2 WHERE id=$1 AND status=$3 RETURNING id", [id, status, prior]
  );
  if (!result.rowCount) throw new PosError("Order not found or status has changed.", 409);
  return { ok: true };
}

export async function setStock(id: string, stock: number) {
  if (!Number.isInteger(stock) || stock < 0 || stock > 10000) throw new PosError("Enter a valid available quantity.");
  const result = await (await db()).query("UPDATE products SET stock=$2 WHERE id=$1 RETURNING id", [id, stock]);
  if (!result.rowCount) throw new PosError("Product not found.", 404);
  return { ok: true };
}

export async function updateProduct(id: string, pricePaise: number, stock: number, active: boolean) {
  if (!Number.isInteger(pricePaise) || pricePaise < 0 || pricePaise > 1000000) throw new PosError("Enter a valid price.");
  if (!Number.isInteger(stock) || stock < 0 || stock > 10000) throw new PosError("Enter a valid available quantity.");
  if (typeof active !== "boolean") throw new PosError("Invalid availability.");
  const result = await (await db()).query(
    "UPDATE products SET price_paise=$2, stock=$3, active=$4 WHERE id=$1 RETURNING id", [id, pricePaise, stock, active]
  );
  if (!result.rowCount) throw new PosError("Product not found.", 404);
  return { ok: true };
}
