export type Product = {
  id: string; name: string; category: string; price_paise: number; stock: number; active: boolean;
  aliases: string[]; pairings: string[]; substitutes: string[]; options: string[];
  flavors: string[];
};
export type CartItem = { product_id: string; name: string; option_name: string; quantity: number; unit_price_paise: number };
export type OrderItem = CartItem & { order_id: string };
export type Order = {
  id: string; table_no: number; status: "new" | "preparing" | "ready" | "served" | "cancelled";
  payment_status: "unpaid" | "pending" | "paid" | "failed";
  total_paise: number; qr_image: string | null; created_at: string; items: OrderItem[];
};
export type PosState = { products: Product[]; cart: CartItem[]; orders: Order[] };
