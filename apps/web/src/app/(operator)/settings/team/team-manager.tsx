"use client";

/**
 * The Staff and linemen page body (T-032). Linemen first (each with their phones), then staff.
 * One primary button: "Add lineman" (page header). Every row action is icon + word; destructive
 * ones ask first in plain words. While the tenant is read-only the list shows without buttons.
 * Every action is checked again on the server (Owner only, tenant scope, read-only mode).
 */
import {
  Button,
  ConfirmSheet,
  EmptyState,
  Icon,
  PAGE_ACTION_CLEARANCE,
  StatusPill,
  useToast,
} from "@cb/ui";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { ShellPageHeader } from "@/components/shell/shell-page-header";
import type { AddResult, DoneResult, PasswordRules, TeamErrorKey } from "./action-state";
import {
  AddLinemanDialog,
  type AddLinemanInputValues,
  AddStaffDialog,
  type AddStaffInputValues,
  NewPasswordDialog,
  ShareLink,
} from "./dialogs";
import { Notice } from "./fields";
import type { MemberRow, PhoneRow } from "./rows";

/** The Server Actions (passed in so tests can use fakes). */
export interface TeamActions {
  addLineman(values: AddLinemanInputValues): Promise<AddResult>;
  addStaff(values: AddStaffInputValues): Promise<AddResult>;
  resetPassword(userId: string, password: string): Promise<DoneResult>;
  switchOff(userId: string): Promise<DoneResult>;
  switchOn(userId: string): Promise<DoneResult>;
  signOutPhone(deviceId: string): Promise<DoneResult>;
}

type Open =
  | { kind: "add_lineman" }
  | { kind: "add_staff" }
  | { kind: "password"; member: MemberRow }
  | { kind: "switch_off"; member: MemberRow }
  | { kind: "sign_out_phone"; member: MemberRow; phone: PhoneRow }
  | null;

function PhoneItem({
  phone,
  editable,
  onSignOut,
}: {
  phone: PhoneRow;
  editable: boolean;
  onSignOut: () => void;
}) {
  const t = useTranslations("team.phones");
  return (
    <li
      data-phone={phone.id}
      className="flex flex-col gap-2 rounded-md border-hairline border-border p-3 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex min-w-0 items-start gap-3">
        <Icon name="device" className="mt-1 shrink-0" />
        <div className="flex min-w-0 flex-col gap-1">
          <span className="break-words font-strong text-base">{phone.label}</span>
          <span className="text-sm text-text-muted">
            {[phone.appVersion, phone.lastOnline].filter(Boolean).join(" · ")}
          </span>
          <span>
            {phone.signedIn ? (
              <StatusPill variant="success" label={t("signed_in")} />
            ) : (
              <StatusPill variant="pending" icon="logout" label={t("signed_out")} />
            )}
          </span>
        </div>
      </div>
      {editable && !phone.signedOut ? (
        <Button variant="secondary" icon="logout" className="shrink-0" onClick={onSignOut}>
          {t("sign_out")}
        </Button>
      ) : null}
    </li>
  );
}

function MemberCard({
  member,
  editable,
  onOpen,
  onSwitchOn,
  switchingOn,
}: {
  member: MemberRow;
  editable: boolean;
  onOpen: (open: Open) => void;
  onSwitchOn: () => void;
  switchingOn: boolean;
}) {
  const t = useTranslations("team");
  const lineman = member.role === "lineman";
  return (
    <li
      data-member={member.name}
      className="flex flex-col gap-4 rounded-lg border-hairline border-border bg-bg p-4"
    >
      <div className="flex min-w-0 items-start gap-3">
        <Icon
          name={lineman ? "lineman" : "team"}
          className={member.active ? "mt-1 shrink-0" : "mt-1 shrink-0 text-text-muted"}
        />
        <div className="flex min-w-0 flex-col gap-1">
          <span className="break-words font-strong text-lg">{member.name}</span>
          <span className="flex flex-wrap gap-2">
            {member.active ? (
              <StatusPill variant="success" label={t("status.active")} />
            ) : (
              <StatusPill variant="danger" icon="switch-off" label={t("status.switched_off")} />
            )}
            {!member.passwordSet ? (
              <StatusPill variant="pending" label={t("status.no_password")} />
            ) : null}
          </span>
          <span className="break-all font-numeric text-base">
            {t("member.login", { login: member.login })}
          </span>
          {member.mobile ? (
            <span className="font-numeric text-base">
              {t("member.mobile", { mobile: member.mobile })}
            </span>
          ) : null}
          {member.email ? (
            <span className="break-all text-base">
              {t("member.email", { email: member.email })}
            </span>
          ) : null}
        </div>
      </div>

      {lineman ? (
        <section className="flex flex-col gap-2" aria-label={t("phones.title")}>
          <h3 className="font-strong text-base">{t("phones.title")}</h3>
          {member.phones.length === 0 ? (
            <p className="text-base text-text-muted">{t("phones.none")}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {member.phones.map((phone) => (
                <PhoneItem
                  key={phone.id}
                  phone={phone}
                  editable={editable}
                  onSignOut={() => onOpen({ kind: "sign_out_phone", member, phone })}
                />
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {editable ? (
        <div className="flex flex-wrap gap-2">
          {lineman && member.active && member.shareUrl ? (
            <ShareLink href={member.shareUrl} name={member.name} />
          ) : null}
          <Button
            variant="secondary"
            icon="password"
            aria-label={t("actions.new_password_label", { name: member.name })}
            onClick={() => onOpen({ kind: "password", member })}
          >
            {t("actions.new_password")}
          </Button>
          {member.active ? (
            <Button
              variant="secondary"
              icon="switch-off"
              aria-label={t("actions.switch_off_label", { name: member.name })}
              onClick={() => onOpen({ kind: "switch_off", member })}
            >
              {t("actions.switch_off")}
            </Button>
          ) : (
            <Button
              variant="secondary"
              icon="switch-on"
              aria-label={t("actions.switch_on_label", { name: member.name })}
              loading={switchingOn}
              onClick={onSwitchOn}
            >
              {t("actions.switch_on")}
            </Button>
          )}
        </div>
      ) : null}
    </li>
  );
}

export function TeamManager({
  title,
  linemen,
  staff,
  editable,
  readOnly,
  rules,
  suggestedPassword,
  actions,
}: {
  title: string;
  linemen: readonly MemberRow[];
  staff: readonly MemberRow[];
  editable: boolean;
  readOnly: boolean;
  rules: PasswordRules;
  /** A random 6-digit password made on the server for "Make one for me". */
  suggestedPassword: string;
  actions: TeamActions;
}) {
  const t = useTranslations("team");
  const common = useTranslations("common");
  const { toast } = useToast();
  const [open, setOpen] = useState<Open>(null);
  const [switchingOn, setSwitchingOn] = useState<string | null>(null);
  const [, startSwitchOn] = useTransition();
  const close = (isOpen: boolean) => {
    if (!isOpen) setOpen(null);
  };
  const fail = (error: TeamErrorKey | undefined) =>
    toast({ variant: "danger", title: t(`error.${error ?? "unexpected"}`) });

  const addButton = (
    <Button size="lg" icon="add" onClick={() => setOpen({ kind: "add_lineman" })}>
      {t("add_lineman")}
    </Button>
  );

  const cards = (members: readonly MemberRow[]) => (
    <ul className="flex flex-col gap-3">
      {members.map((member) => (
        <MemberCard
          key={member.id}
          member={member}
          editable={editable}
          onOpen={setOpen}
          switchingOn={switchingOn === member.id}
          onSwitchOn={() => {
            setSwitchingOn(member.id);
            startSwitchOn(async () => {
              const result = await actions.switchOn(member.id);
              setSwitchingOn(null);
              if (result.ok) {
                toast({ variant: "success", title: t("switch_on.done", { name: member.name }) });
              } else {
                fail(result.error);
              }
            });
          }}
        />
      ))}
    </ul>
  );

  return (
    <div className={`flex flex-col gap-6 ${editable ? PAGE_ACTION_CLEARANCE : ""}`}>
      <ShellPageHeader
        title={title}
        description={t("description")}
        {...(editable ? { action: addButton } : {})}
      />
      {readOnly ? <Notice tone="pending">{t("read_only")}</Notice> : null}

      <section className="flex flex-col gap-3" aria-labelledby="team-linemen">
        <h2 id="team-linemen" className="flex items-center gap-2 font-strong text-xl">
          <Icon name="lineman" className="shrink-0" />
          {t("linemen_title")}
          <span className="font-numeric text-text-muted">{linemen.length}</span>
        </h2>
        {linemen.length === 0 ? (
          <EmptyState icon="lineman" message={t("linemen_empty")} />
        ) : (
          cards(linemen)
        )}
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="team-staff">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="team-staff" className="flex items-center gap-2 font-strong text-xl">
            <Icon name="team" className="shrink-0" />
            {t("staff_title")}
            <span className="font-numeric text-text-muted">{staff.length}</span>
          </h2>
          {editable ? (
            <Button variant="secondary" icon="add" onClick={() => setOpen({ kind: "add_staff" })}>
              {t("add_staff")}
            </Button>
          ) : null}
        </div>
        {staff.length === 0 ? <EmptyState icon="team" message={t("staff_empty")} /> : cards(staff)}
      </section>

      {open?.kind === "add_lineman" ? (
        <AddLinemanDialog
          open
          onOpenChange={close}
          rules={rules}
          suggestion={suggestedPassword}
          onSave={actions.addLineman}
        />
      ) : null}
      {open?.kind === "add_staff" ? (
        <AddStaffDialog open onOpenChange={close} rules={rules} onSave={actions.addStaff} />
      ) : null}
      {open?.kind === "password" ? (
        <NewPasswordDialog
          key={open.member.id}
          member={open.member}
          open
          onOpenChange={close}
          rules={rules}
          suggestion={suggestedPassword}
          onSave={actions.resetPassword}
        />
      ) : null}
      {open?.kind === "switch_off" ? (
        <ConfirmSheet
          open
          onOpenChange={close}
          tone="danger"
          title={t("switch_off.title", { name: open.member.name })}
          summary={
            open.member.role === "lineman"
              ? t("switch_off.summary_lineman", { name: open.member.name })
              : t("switch_off.summary_staff", { name: open.member.name })
          }
          confirmLabel={t("switch_off.confirm")}
          confirmIcon="switch-off"
          cancelLabel={common("cancel")}
          loadingLabel={t("form.saving")}
          onConfirm={async () => {
            const member = open.member;
            const result = await actions.switchOff(member.id);
            if (result.ok) {
              toast({ variant: "success", title: t("switch_off.done", { name: member.name }) });
            } else {
              fail(result.error);
            }
          }}
        />
      ) : null}
      {open?.kind === "sign_out_phone" ? (
        <ConfirmSheet
          open
          onOpenChange={close}
          tone="danger"
          title={t("phones.sign_out_title")}
          summary={t("phones.sign_out_summary", { phone: open.phone.label })}
          confirmLabel={t("phones.sign_out_confirm")}
          confirmIcon="logout"
          cancelLabel={common("cancel")}
          loadingLabel={t("form.saving")}
          onConfirm={async () => {
            const result = await actions.signOutPhone(open.phone.id);
            if (result.ok) toast({ variant: "success", title: t("phones.signed_out_done") });
            else fail(result.error);
          }}
        />
      ) : null}
    </div>
  );
}
