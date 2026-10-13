"use client";

/**
 * The Areas page body (T-030): the list (name, how many customers, "Hidden"), and for the Owner
 * "Add area" (page header), "Change name" and "Hide" / "Show again" on each row. Staff (and the
 * Owner while the tenant is read-only) see the list without buttons. Every action is checked again
 * on the server.
 */
import type { AreaView, SettingsReadOnlyReason } from "@cb/core";
import {
  Button,
  ConfirmSheet,
  Dialog,
  EmptyState,
  Icon,
  Input,
  PAGE_ACTION_CLEARANCE,
  useToast,
} from "@cb/ui";
import { useTranslations } from "next-intl";
import { type FormEvent, useId, useState, useTransition } from "react";
import { ShellPageHeader } from "@/components/shell/shell-page-header";
import { FieldNote, Notice, noteId } from "../profile/field";
import type { AreaActionResult, AreaErrorKey } from "./action-state";

/** The four Server Actions (passed in so tests can use fakes). */
export interface AreaActions {
  create(name: string): Promise<AreaActionResult>;
  rename(areaId: string, name: string): Promise<AreaActionResult>;
  archive(areaId: string): Promise<AreaActionResult>;
  restore(areaId: string): Promise<AreaActionResult>;
}

/** An area as the page receives it (dates are serialised by the server → client boundary). */
export type AreaRow = Omit<AreaView, "archivedAt"> & { readonly hidden: boolean };

/** Add or rename: one name field, Save. Keeps the dialog open and says what is wrong. */
function NameDialog({
  title,
  initialName,
  open,
  onOpenChange,
  onSave,
}: {
  title: string;
  initialName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (name: string) => Promise<AreaActionResult>;
}) {
  const t = useTranslations("settings.areas");
  const common = useTranslations("common");
  const id = useId();
  const [name, setName] = useState(initialName);
  const [error, setError] = useState<AreaErrorKey | null>(null);
  const [pending, startTransition] = useTransition();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    startTransition(async () => {
      const result = await onSave(name);
      if (result.ok) {
        onOpenChange(false);
      } else {
        setError(result.error);
      }
    });
  };

  return (
    <Dialog title={title} closeLabel={common("close")} open={open} onOpenChange={onOpenChange}>
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <label htmlFor={id} className="font-strong text-base">
            {t("name_label")}
          </label>
          <Input
            id={id}
            name="name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
            maxLength={60}
            autoComplete="off"
            required
            invalid={error !== null}
            aria-describedby={noteId(id)}
          />
          <FieldNote id={id} {...(error ? { error: t(`error.${error}`) } : {})} />
        </div>
        <Button type="submit" size="lg" icon="success" loading={pending} loadingLabel={t("saving")}>
          {t("save")}
        </Button>
      </form>
    </Dialog>
  );
}

type Editing = { kind: "add" } | { kind: "rename"; area: AreaRow } | null;

export function AreasManager({
  title,
  areas,
  editable,
  readOnlyReason,
  actions,
}: {
  title: string;
  areas: readonly AreaRow[];
  editable: boolean;
  readOnlyReason: SettingsReadOnlyReason | null;
  actions: AreaActions;
}) {
  const t = useTranslations("settings");
  const common = useTranslations("common");
  const { toast } = useToast();
  const [editing, setEditing] = useState<Editing>(null);
  const [hiding, setHiding] = useState<AreaRow | null>(null);
  const [restoring, startRestore] = useTransition();

  const fail = (error: AreaErrorKey) =>
    toast({ variant: "danger", title: t(`areas.error.${error}`) });

  /** Runs an action; on success shows `done`. Returns the result for the dialogs. */
  const perform = async (call: Promise<AreaActionResult>, done: string) => {
    const result = await call;
    if (result.ok) toast({ variant: "success", title: done });
    return result;
  };

  const addButton = (
    <Button size="lg" icon="add" onClick={() => setEditing({ kind: "add" })}>
      {t("areas.add")}
    </Button>
  );

  return (
    <div className={`flex flex-col gap-6 ${editable ? PAGE_ACTION_CLEARANCE : ""}`}>
      <ShellPageHeader
        title={title}
        description={t("areas.description")}
        {...(editable ? { action: addButton } : {})}
      />
      {readOnlyReason ? <Notice tone="pending">{t(`read_only.${readOnlyReason}`)}</Notice> : null}

      {areas.length === 0 ? (
        <EmptyState icon="area" message={editable ? t("areas.empty") : t("areas.empty_staff")} />
      ) : (
        <ul aria-label={t("areas.list_label")} className="flex flex-col gap-3">
          {areas.map((area) => (
            <li
              key={area.id}
              data-area={area.name}
              className="flex flex-col gap-3 rounded-lg border-hairline border-border bg-bg p-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex min-w-0 items-start gap-3">
                <Icon
                  name="area"
                  className={area.hidden ? "mt-1 shrink-0 text-text-muted" : "mt-1 shrink-0"}
                />
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="break-words font-strong text-lg">{area.name}</span>
                  <span className="flex flex-wrap items-center gap-2 text-sm text-text-muted">
                    <span className="font-numeric">
                      {t("areas.customers", { count: area.customerCount })}
                    </span>
                    {area.hidden ? (
                      <span className="inline-flex items-center gap-1 rounded-full border-hairline border-border px-2 text-text">
                        <Icon name="hide" className="size-4 shrink-0" />
                        {t("areas.hidden")}
                      </span>
                    ) : null}
                  </span>
                </div>
              </div>
              {editable ? (
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="secondary"
                    icon="edit"
                    aria-label={`${t("areas.rename")}: ${area.name}`}
                    onClick={() => setEditing({ kind: "rename", area })}
                  >
                    {t("areas.rename")}
                  </Button>
                  {area.hidden ? (
                    <Button
                      variant="secondary"
                      icon="show"
                      aria-label={`${t("areas.show_again")}: ${area.name}`}
                      loading={restoring}
                      onClick={() =>
                        startRestore(async () => {
                          const result = await perform(
                            actions.restore(area.id),
                            t("areas.shown_done"),
                          );
                          if (!result.ok) fail(result.error);
                        })
                      }
                    >
                      {t("areas.show_again")}
                    </Button>
                  ) : (
                    <Button
                      variant="secondary"
                      icon="hide"
                      aria-label={`${t("areas.hide")}: ${area.name}`}
                      onClick={() => setHiding(area)}
                    >
                      {t("areas.hide")}
                    </Button>
                  )}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {editing ? (
        <NameDialog
          key={editing.kind === "add" ? "add" : editing.area.id}
          title={editing.kind === "add" ? t("areas.add_title") : t("areas.rename_title")}
          initialName={editing.kind === "add" ? "" : editing.area.name}
          open
          onOpenChange={(open) => {
            if (!open) setEditing(null);
          }}
          onSave={(name) =>
            editing.kind === "add"
              ? perform(actions.create(name), t("areas.added"))
              : perform(actions.rename(editing.area.id, name), t("areas.renamed"))
          }
        />
      ) : null}

      {hiding ? (
        <ConfirmSheet
          open
          onOpenChange={(open) => {
            if (!open) setHiding(null);
          }}
          title={t("areas.hide_title", { name: hiding.name })}
          summary={t("areas.hide_summary", { count: hiding.customerCount })}
          confirmLabel={t("areas.hide_confirm")}
          confirmIcon="hide"
          cancelLabel={common("cancel")}
          loadingLabel={t("areas.saving")}
          onConfirm={async () => {
            const result = await perform(actions.archive(hiding.id), t("areas.hidden_done"));
            if (!result.ok) fail(result.error);
          }}
        />
      ) : null}
    </div>
  );
}
