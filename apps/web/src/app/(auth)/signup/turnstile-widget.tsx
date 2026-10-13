"use client";

import Script from "next/script";
import { useEffect, useRef, useState } from "react";

/** The part of Cloudflare's `window.turnstile` API we use (explicit rendering). */
interface TurnstileApi {
  render(
    container: HTMLElement,
    options: {
      sitekey: string;
      language?: string;
      size?: "normal" | "flexible" | "compact";
    },
  ): string | undefined;
  reset(widgetId: string): void;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

/**
 * Cloudflare Turnstile's "check that you are a person" box (E-07). It puts its token in a hidden
 * `cf-turnstile-response` field (its default name; `TURNSTILE_RESPONSE_FIELD` on the server) of
 * the surrounding form; the server checks it once. `resetKey`
 * changes after every answer from the server, which asks Cloudflare for a fresh token (each
 * token works only once). Rendered only when the site key is configured.
 */
export function TurnstileWidget({
  siteKey,
  language,
  label,
  resetKey,
}: {
  siteKey: string;
  language: string;
  label: string;
  resetKey: number;
}) {
  const container = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | undefined>(undefined);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (window.turnstile) setReady(true);
  }, []);

  useEffect(() => {
    const api = window.turnstile;
    if (!ready || !api || !container.current) return;
    if (widgetId.current === undefined) {
      widgetId.current = api.render(container.current, {
        sitekey: siteKey,
        language,
        size: "flexible",
      });
    } else if (resetKey > 0) {
      api.reset(widgetId.current);
    }
  }, [ready, siteKey, language, resetKey]);

  useEffect(
    () => () => {
      if (widgetId.current !== undefined) window.turnstile?.remove(widgetId.current);
      widgetId.current = undefined;
    },
    [],
  );

  return (
    <>
      <Script src={SCRIPT_URL} strategy="afterInteractive" onReady={() => setReady(true)} />
      <section aria-label={label} className="min-h-touch-min">
        <div ref={container} />
      </section>
    </>
  );
}
