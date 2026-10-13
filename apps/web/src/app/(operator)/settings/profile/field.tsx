/**
 * Form pieces shared by the settings pages (T-030): a labelled field with its hint or error in
 * words (icon + colour + words, PLAN §2.2), and the form-level message box. No hooks, so server
 * and client components can both use them.
 */
import { Icon } from "@cb/ui";
import type { ReactNode } from "react";

/** The id of a field's note (hint or error), for `aria-describedby`. */
export const noteId = (id: string) => `${id}-note`;

export function FieldNote({ id, hint, error }: { id: string; hint?: string; error?: string }) {
  if (error) {
    return (
      <p id={noteId(id)} className="flex items-start gap-2 text-base text-danger">
        <Icon name="danger" className="mt-1 shrink-0" />
        <span>{error}</span>
      </p>
    );
  }
  if (!hint) return null;
  return (
    <p id={noteId(id)} className="text-sm text-text-muted">
      {hint}
    </p>
  );
}

/** Label, the control (`children`), then the hint or the error. */
export function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="font-strong text-base">
        {label}
      </label>
      {children}
      <FieldNote id={id} {...(hint ? { hint } : {})} {...(error ? { error } : {})} />
    </div>
  );
}

/** A box at the top of a form or page: a problem (red) or a notice (amber), announced. */
export function Notice({ tone, children }: { tone: "danger" | "pending"; children: ReactNode }) {
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={
        tone === "danger"
          ? "flex items-start gap-3 rounded-md border-hairline border-danger p-3 text-base text-danger"
          : "flex items-start gap-3 rounded-md border-hairline border-pending p-3 text-base text-text"
      }
    >
      <Icon
        name={tone === "danger" ? "danger" : "pending"}
        className={tone === "danger" ? "mt-1 shrink-0" : "mt-1 shrink-0 text-pending"}
      />
      <p>{children}</p>
    </div>
  );
}
