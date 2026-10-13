/** A form's message at the top: icon + colour + words, announced to screen readers. */
import { Icon } from "@cb/ui";
import type { ReactNode } from "react";

export function FormMessage({
  tone,
  children,
}: {
  tone: "danger" | "success";
  children: ReactNode;
}) {
  const danger = tone === "danger";
  return (
    <div
      role={danger ? "alert" : "status"}
      className={
        danger
          ? "flex items-start gap-3 rounded-md border-hairline border-danger p-3 text-base text-danger"
          : "flex items-start gap-3 rounded-md border-hairline border-success p-3 text-base text-success"
      }
    >
      <Icon name={danger ? "danger" : "success"} className="mt-1 shrink-0" />
      <div className="flex flex-col gap-2">{children}</div>
    </div>
  );
}
