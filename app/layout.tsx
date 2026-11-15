import type { Metadata } from "next";
import "./globals.css";
import "./catalog.css";

export const metadata: Metadata = {
  title: "CounterCloser AI",
  description: "A local cafe POS with Roy, the voice waiter"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
