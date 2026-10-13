/**
 * Outgoing email (E-07: Resend). Auth sends one kind today: the password-reset link.
 *
 * - `createResendTransport`: Resend's REST API (`POST https://api.resend.com/emails`), no SDK.
 * - `createCaptureTransport`: keeps messages in memory. Tests read the reset link from it; local
 *   development uses it when `RESEND_API_KEY` is unset.
 *
 * Addresses and bodies are personal data: never log them.
 */

export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  /** Plain-text body (we send text only: short, works in every mail app). */
  readonly text: string;
}

export interface EmailTransport {
  readonly kind: "resend" | "capture";
  send(message: EmailMessage): Promise<void>;
}

export interface ResendTransportOptions {
  /** `RESEND_API_KEY` (`re_…`). */
  readonly apiKey: string;
  /** `EMAIL_FROM`, e.g. `Cable Billing <noreply@example.com>`. */
  readonly from: string;
  readonly fetch?: typeof fetch;
  /** Default 10 s. */
  readonly timeoutMs?: number;
  /** Default `https://api.resend.com`. */
  readonly endpoint?: string;
}

export function createResendTransport(options: ResendTransportOptions): EmailTransport {
  const doFetch = options.fetch ?? fetch;
  const endpoint = (options.endpoint ?? "https://api.resend.com").replace(/\/+$/, "");
  return {
    kind: "resend",
    async send(message) {
      const response = await doFetch(`${endpoint}/emails`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: options.from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
        }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      });
      // The status only: Resend's error body can echo the recipient.
      if (!response.ok) throw new Error(`Resend rejected the email (HTTP ${response.status})`);
    },
  };
}

export interface CaptureTransport extends EmailTransport {
  readonly kind: "capture";
  /** Every message sent, oldest first. */
  readonly messages: readonly EmailMessage[];
  /** The newest message to `to`, if any. */
  lastTo(to: string): EmailMessage | undefined;
  clear(): void;
}

export function createCaptureTransport(
  options: { onSend?: (message: EmailMessage) => void } = {},
): CaptureTransport {
  const messages: EmailMessage[] = [];
  return {
    kind: "capture",
    messages,
    async send(message) {
      messages.push(message);
      options.onSend?.(message);
    },
    lastTo(to) {
      const wanted = to.toLowerCase();
      return messages.findLast((m) => m.to.toLowerCase() === wanted);
    },
    clear() {
      messages.length = 0;
    },
  };
}
