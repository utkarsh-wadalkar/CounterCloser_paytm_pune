import { Pool, type PoolClient } from "pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

const globalPool = globalThis as typeof globalThis & { counterPool?: Pool; counterInit?: Promise<void> };
export const pool = globalPool.counterPool ?? new Pool({ connectionString, max: 10 });
globalPool.counterPool = pool;

const schema = `
CREATE TABLE IF NOT EXISTS products (
  id text PRIMARY KEY,
  name text NOT NULL,
  category text NOT NULL,
  price_paise integer NOT NULL CHECK (price_paise >= 0),
  stock integer NOT NULL CHECK (stock >= 0),
  active boolean NOT NULL DEFAULT true,
  aliases text[] NOT NULL DEFAULT '{}',
  pairings text[] NOT NULL DEFAULT '{}',
  substitutes text[] NOT NULL DEFAULT '{}',
  options text[] NOT NULL DEFAULT '{}'
);
ALTER TABLE products ADD COLUMN IF NOT EXISTS flavors text[] NOT NULL DEFAULT '{}';
CREATE TABLE IF NOT EXISTS carts (
  id uuid PRIMARY KEY,
  table_no integer NOT NULL CHECK (table_no BETWEEN 1 AND 50),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','confirmed','cancelled')),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS one_draft_cart_per_table ON carts (table_no) WHERE status = 'draft';
CREATE TABLE IF NOT EXISTS cart_items (
  cart_id uuid NOT NULL REFERENCES carts(id),
  product_id text NOT NULL REFERENCES products(id),
  option_name text NOT NULL DEFAULT '',
  quantity integer NOT NULL CHECK (quantity > 0),
  unit_price_paise integer NOT NULL,
  PRIMARY KEY (cart_id, product_id, option_name)
);
CREATE TABLE IF NOT EXISTS cart_mutations (
  request_id text PRIMARY KEY,
  table_no integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS orders (
  id uuid PRIMARY KEY,
  table_no integer NOT NULL,
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','preparing','ready','served','cancelled')),
  payment_status text NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid','pending','paid','failed')),
  total_paise integer NOT NULL,
  qr_image text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS order_items (
  order_id uuid NOT NULL REFERENCES orders(id),
  product_id text NOT NULL,
  name text NOT NULL,
  option_name text NOT NULL DEFAULT '',
  quantity integer NOT NULL,
  unit_price_paise integer NOT NULL
);
`;

const seed = [
  ["cold-coffee", "Cold coffee", "Drinks", 8000, 1, ["cold coffee", "coffee"], ["fries"], ["iced-latte"], [], ["Classic", "Mocha", "Vanilla"]],
  ["iced-latte", "Iced latte", "Drinks", 9000, 6, ["iced latte", "latte"], [], ["cold-coffee"], [], ["Classic", "Vanilla", "Caramel"]],
  ["green-tea", "Green tea", "Drinks", 7000, 8, ["green tea", "tea"], [], [], [], ["Plain", "Lemon", "Mint"]],
  ["sandwich", "Sandwich", "Food", 13000, 5, ["sandwich"], ["cold-coffee"], [], ["Ketchup", "Mayonnaise"], ["Veg", "Cheese", "Grilled"]],
  ["pizza", "Pizza", "Food", 25000, 4, ["pizza"], ["fries", "iced-latte"], [], ["Ketchup", "Mayonnaise"], ["Margherita", "Farmhouse", "Pepper"]],
  ["burger", "Burger", "Food", 16000, 6, ["burger"], ["fries", "iced-latte"], [], ["Ketchup", "Mayonnaise"], ["Classic", "Cheese", "Spicy"]],
  ["fries", "French fries", "Sides", 7000, 10, ["fries", "french fries"], ["iced-latte"], [], ["Ketchup", "Mayonnaise"], ["Salted", "Peri Peri", "Cheese"]]
] as const;

export async function db(): Promise<Pool> {
  if (!globalPool.counterInit) {
    globalPool.counterInit = (async () => {
      const client = await pool.connect();
      try {
        await client.query(schema);
        for (const item of seed) {
          await client.query(
            `INSERT INTO products (id,name,category,price_paise,stock,aliases,pairings,substitutes,options,flavors)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO UPDATE SET flavors=EXCLUDED.flavors`,
            [...item]
          );
        }
      } finally {
        client.release();
      }
    })().catch((error) => {
      globalPool.counterInit = undefined;
      throw error;
    });
  }
  await globalPool.counterInit;
  return pool;
}

export async function transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await (await db()).connect();
  try {
    await client.query("BEGIN");
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
