"use client";

/**
 * Reloads the page data every few seconds while a bill run is being made (the `billing.run` job
 * works in the background, T-044), so the Owner sees it finish without pressing anything. Renders
 * nothing; the page says "This page updates by itself".
 */
import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** How often the page asks for fresh data while bills are being made. */
export const RUN_REFRESH_MS = 5_000;

export function AutoRefresh({ everyMs = RUN_REFRESH_MS }: { readonly everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(() => router.refresh(), everyMs);
    return () => clearInterval(timer);
  }, [router, everyMs]);
  return null;
}
