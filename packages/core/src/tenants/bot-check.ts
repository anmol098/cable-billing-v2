/**
 * Bot protection on sign-up (E-07: Cloudflare Turnstile).
 *
 * - `createTurnstileVerifier`: server-side check of the widget's token with Cloudflare's
 *   `siteverify` endpoint (form post, no SDK). Each token works once.
 * - `disabledBotCheck`: passes everything. Only for local development, CI and tests, where no
 *   Turnstile keys are set (production requires the keys: apps/web env rules, T-011).
 *
 * Network and Cloudflare errors reject; the sign-up service then refuses the sign-up (fails
 * closed: an outage stops new sign-ups for a while, it never lets bots through).
 */

export interface BotCheck {
  readonly kind: "turnstile" | "disabled";
  /** True when `token` (the widget's `cf-turnstile-response`) proves a person filled the form. */
  verify(input: { readonly token: string; readonly ip?: string | undefined }): Promise<boolean>;
}

export interface TurnstileVerifierOptions {
  /** `TURNSTILE_SECRET_KEY`. */
  readonly secret: string;
  readonly fetch?: typeof fetch;
  /** Default 5 s. */
  readonly timeoutMs?: number;
  /** Default Cloudflare's `https://challenges.cloudflare.com/turnstile/v0/siteverify`. */
  readonly endpoint?: string;
}

export const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
/** The form field the Turnstile widget adds to its form. */
export const TURNSTILE_RESPONSE_FIELD = "cf-turnstile-response";
/** Cloudflare's limit for a token. */
const MAX_TOKEN_LENGTH = 2048;

export function createTurnstileVerifier(options: TurnstileVerifierOptions): BotCheck {
  const doFetch = options.fetch ?? fetch;
  const endpoint = options.endpoint ?? TURNSTILE_VERIFY_URL;
  return {
    kind: "turnstile",
    async verify({ token, ip }) {
      if (!token || token.length > MAX_TOKEN_LENGTH) return false;
      const body = new URLSearchParams({ secret: options.secret, response: token });
      if (ip) body.set("remoteip", ip);
      const response = await doFetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
      });
      if (!response.ok) throw new Error(`Turnstile siteverify failed (HTTP ${response.status})`);
      const result = (await response.json()) as { success?: unknown };
      return result.success === true;
    },
  };
}

/** Lets every sign-up through. Local development, CI and tests only. */
export function disabledBotCheck(): BotCheck {
  return {
    kind: "disabled",
    async verify() {
      return true;
    },
  };
}
