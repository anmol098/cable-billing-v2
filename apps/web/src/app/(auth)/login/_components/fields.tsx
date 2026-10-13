"use client";

import { Button, Icon, Input } from "@cb/ui";
import { useTranslations } from "next-intl";
import { type ComponentProps, useState } from "react";
import { useFormStatus } from "react-dom";

/** A labelled text field, large and full width. */
export function TextField({
  id,
  label,
  invalid,
  ...props
}: Omit<ComponentProps<typeof Input>, "id"> & { id: string; label: string }) {
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="font-strong text-base">
        {label}
      </label>
      <Input id={id} invalid={invalid} className="text-lg" {...props} />
    </div>
  );
}

/**
 * A password field with a big Show / Hide button next to it (icon + word), so people who
 * mistype can check what they wrote (PLAN §2.2, D-07).
 */
export function PasswordField({
  id,
  label,
  invalid,
  ...props
}: Omit<ComponentProps<typeof Input>, "id" | "type"> & { id: string; label: string }) {
  const t = useTranslations("auth.password");
  const [visible, setVisible] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="font-strong text-base">
        {label}
      </label>
      <div className="flex items-stretch gap-2">
        <Input
          id={id}
          type={visible ? "text" : "password"}
          invalid={invalid}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className="text-lg"
          {...props}
        />
        <Button
          variant="secondary"
          icon={visible ? "hide" : "show"}
          aria-label={visible ? t("hide_label") : t("show_label")}
          aria-pressed={visible}
          aria-controls={id}
          onClick={() => setVisible((v) => !v)}
          className="shrink-0"
        >
          {visible ? t("hide") : t("show")}
        </Button>
      </div>
    </div>
  );
}

/** The screen's one primary button; shows a spinner and a "…ing" word while the form submits. */
export function SubmitButton({
  icon,
  label,
  pendingLabel,
}: {
  icon: ComponentProps<typeof Button>["icon"];
  label: string;
  pendingLabel: string;
}) {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      size="lg"
      icon={icon}
      loading={pending}
      loadingLabel={pendingLabel}
      className="w-full"
    >
      {label}
    </Button>
  );
}

/** An error (or notice) box: icon + colour + words, announced to screen readers. */
export function Message({
  tone,
  children,
}: {
  tone: "danger" | "success";
  children: React.ReactNode;
}) {
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={
        tone === "danger"
          ? "flex items-start gap-3 rounded-md border-hairline border-danger p-3 text-base text-danger"
          : "flex items-start gap-3 rounded-md border-hairline border-success p-3 text-base text-success"
      }
    >
      <Icon name={tone === "danger" ? "danger" : "success"} className="mt-1 shrink-0" />
      <p>{children}</p>
    </div>
  );
}
