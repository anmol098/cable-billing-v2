"use client";

/**
 * Receipt actions for one payment (T-048, PLAN §12.1 "print/share"): print the A5 receipt (a PDF
 * in a new tab, the browser prints it) and copy a receipt link (T-050) to paste into WhatsApp or
 * SMS. Honest states (BR-12): the app only says the link was **copied**; it never says a message
 * was sent. When the clipboard is not available the link is shown in a box to copy by hand.
 */
import { Button, Input, useToast } from "@cb/ui";
import { useTranslations } from "next-intl";
import { useId, useRef, useState } from "react";
import { receiptPrintHref } from "./format";
import type { ReceiptLinkResult } from "./results";

export interface ReceiptActionsProps {
  readonly paymentId: string;
  readonly copyLink: (paymentId: string) => Promise<ReceiptLinkResult>;
  /** Write text to the clipboard (default `navigator.clipboard.writeText`); tests inject one. */
  readonly writeClipboard?: (text: string) => Promise<void>;
}

async function defaultWriteClipboard(text: string): Promise<void> {
  if (!globalThis.navigator?.clipboard) throw new Error("no clipboard");
  await globalThis.navigator.clipboard.writeText(text);
}

export function ReceiptActions({
  paymentId,
  copyLink,
  writeClipboard = defaultWriteClipboard,
}: ReceiptActionsProps) {
  const t = useTranslations("payments.receipt");
  const toast = useToast();
  const fieldId = useId();
  const busy = useRef(false);
  const [loading, setLoading] = useState(false);
  const [link, setLink] = useState<{ url: string; copied: boolean } | null>(null);

  const onCopy = async () => {
    if (busy.current) return;
    busy.current = true;
    setLoading(true);
    let result: ReceiptLinkResult;
    try {
      result = await copyLink(paymentId);
    } catch {
      result = { ok: false, error: "generic" };
    }
    if (!result.ok) {
      toast.toast({ variant: "danger", title: t(`error.${result.error}`) });
    } else {
      let copied = true;
      try {
        await writeClipboard(result.url);
      } catch {
        copied = false;
      }
      setLink({ url: result.url, copied });
      if (copied) toast.toast({ variant: "success", title: t("copied") });
    }
    setLoading(false);
    busy.current = false;
  };

  return (
    <div className="flex flex-col gap-3" data-receipt-actions={paymentId}>
      <div className="flex flex-col gap-3 sm:flex-row">
        <Button asChild variant="secondary" size="lg" icon="print">
          <a href={receiptPrintHref(paymentId)} target="_blank" rel="noopener">
            {t("print")}
          </a>
        </Button>
        <Button
          variant="secondary"
          size="lg"
          icon="share"
          loading={loading}
          loadingLabel={t("copying")}
          onClick={onCopy}
        >
          {t("copy_link")}
        </Button>
      </div>
      {link ? (
        <div className="flex flex-col gap-2">
          <label htmlFor={fieldId} className="text-base text-text">
            {link.copied ? t("link_label") : t("copy_failed_manual")}
          </label>
          <Input
            id={fieldId}
            readOnly
            value={link.url}
            data-testid="receipt-link"
            onFocus={(event) => event.currentTarget.select()}
          />
          <p className="text-sm text-text-muted">{t("link_note")}</p>
        </div>
      ) : null}
    </div>
  );
}
