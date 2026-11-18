import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { Bot } from "lucide-react";

export const metadata: Metadata = { referrer: "no-referrer" };

export default function AuthLayout({ children }: { children: ReactNode }) {
  return <>
    <header className="flex h-16 items-center border-b border-border bg-card px-4 sm:px-8">
      <Link href="/" className="flex items-center gap-2.5 font-semibold">
        <Bot aria-hidden="true" className="size-8 rounded-lg bg-primary p-1.5 text-primary-foreground" />
        Agent Practice
      </Link>
    </header>
    {children}
  </>;
}
