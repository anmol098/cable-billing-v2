"use client";

/**
 * Form pieces for the team dialogs (T-032): a labelled field with its note or error in words, a
 * password field whose Show/Hide starts on "shown" for linemen (D-07: they mistype; the Owner is
 * typing it to tell them anyway), and a notice box. Tokens only.
 */
import { Button, Icon, type IconName, Input } from "@cb/ui";
import { useTranslations } from "next-intl";
import { type ComponentProps, type ReactNode, useState } from "react";

export const noteId = (id: string) => `${id}-note`;

/** A field's note, or its error (icon + colour + words), announced to screen readers. */
export function FieldNote({ id, note, error }: { id: string; note?: string; error?: string }) {
  if (error) {
    return (
      <p id={noteId(id)} role="alert" className="flex items-start gap-2 text-base text-danger">
        <Icon name="danger" className="mt-1 size-4 shrink-0" />
        {error}
      </p>
    );
  }
  if (!note) return null;
  return (
    <p id={noteId(id)} className="text-sm text-text-muted">
      {note}
    </p>
  );
}

export function TextField({
  id,
  label,
  note,
  error,
  ...props
}: Omit<ComponentProps<typeof Input>, "id"> & {
  id: string;
  label: string;
  note?: string;
  error?: string | undefined;
}) {
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="font-strong text-base">
        {label}
      </label>
      <Input
        id={id}
        invalid={Boolean(error)}
        aria-describedby={note || error ? noteId(id) : undefined}
        className="text-lg"
        {...props}
      />
      <FieldNote id={id} {...(note ? { note } : {})} {...(error ? { error } : {})} />
    </div>
  );
}

/** A password field with a Show / Hide button (icon + word) and an optional "Make one for me". */
export function PasswordInput({
  id,
  label,
  value,
  onChange,
  note,
  error,
  defaultVisible,
  suggestion,
  autoComplete = "new-password",
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  note?: string;
  error?: string | undefined;
  defaultVisible: boolean;
  /** When set, a "Make one for me" button fills this password and shows it. */
  suggestion?: string;
  autoComplete?: string;
}) {
  const auth = useTranslations("auth.password");
  const t = useTranslations("team.form");
  const [visible, setVisible] = useState(defaultVisible);
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="font-strong text-base">
        {label}
      </label>
      <div className="flex items-stretch gap-2">
        <Input
          id={id}
          name={id}
          type={visible ? "text" : "password"}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          invalid={Boolean(error)}
          aria-describedby={note || error ? noteId(id) : undefined}
          autoComplete={autoComplete}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className="font-numeric text-lg"
        />
        <Button
          variant="secondary"
          icon={visible ? "hide" : "show"}
          aria-label={visible ? auth("hide_label") : auth("show_label")}
          aria-pressed={visible}
          aria-controls={id}
          onClick={() => setVisible((v) => !v)}
          className="shrink-0"
        >
          {visible ? auth("hide") : auth("show")}
        </Button>
      </div>
      {suggestion ? (
        <Button
          variant="quiet"
          icon="password"
          className="self-start"
          onClick={() => {
            onChange(suggestion);
            setVisible(true);
          }}
        >
          {t("make_password")}
        </Button>
      ) : null}
      <FieldNote id={id} {...(note ? { note } : {})} {...(error ? { error } : {})} />
    </div>
  );
}

/** A notice box: icon + colour + words. */
export function Notice({
  tone,
  icon,
  children,
}: {
  tone: "pending" | "danger" | "success";
  icon?: IconName;
  children: ReactNode;
}) {
  const colour =
    tone === "danger"
      ? "border-danger text-danger"
      : tone === "success"
        ? "border-success text-success"
        : "border-pending text-pending";
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={`flex items-start gap-3 rounded-md border-hairline p-3 text-base ${colour}`}
    >
      <Icon name={icon ?? tone} className="mt-1 shrink-0" />
      <div className="text-text">{children}</div>
    </div>
  );
}
