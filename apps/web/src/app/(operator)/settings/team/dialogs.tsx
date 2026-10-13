"use client";

/**
 * The team dialogs (T-032): "Add lineman", "Add staff" and "New password". Each is one job with
 * one primary button; after saving, the same dialog shows what to tell the person (user name,
 * password, the WhatsApp share link). The server checks every field again.
 */
import { Button, Dialog, Icon, RadioCards, useToast } from "@cb/ui";
import { useTranslations } from "next-intl";
import { type FormEvent, useId, useState, useTransition } from "react";
import type {
  AddedView,
  AddResult,
  DoneResult,
  FieldErrors,
  PasswordRules,
  TeamErrorKey,
  TeamField,
} from "./action-state";
import { Notice, PasswordInput, TextField } from "./fields";

/** Error words for a field (`team.error.<field>.<code>`), with the role's minimum length. */
function useFieldError(fields: FieldErrors, min: number) {
  const t = useTranslations("team.error");
  return (field: TeamField): string | undefined => {
    const key = fields[field];
    return key ? t(key as Parameters<typeof t>[0], { min }) : undefined;
  };
}

function ErrorNotice({ error }: { error: TeamErrorKey | null }) {
  const t = useTranslations("team.error");
  return error ? <Notice tone="danger">{t(error)}</Notice> : null;
}

/** "Share sign-in on WhatsApp": a link (opens WhatsApp); says only "WhatsApp opened". */
export function ShareLink({
  href,
  name,
  variant = "secondary",
}: {
  href: string;
  name: string;
  variant?: "primary" | "secondary";
}) {
  const t = useTranslations("team.actions");
  const { toast } = useToast();
  return (
    <Button asChild variant={variant} icon="whatsapp">
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={t("share_label", { name })}
        onClick={() => toast({ variant: "success", title: t("whatsapp_opened") })}
      >
        {t("share")}
      </a>
    </Button>
  );
}

/** The "added" screen: what to tell the new person. */
function AddedSummary({
  added,
  password,
  onDone,
}: {
  added: AddedView;
  password: string | null;
  onDone: () => void;
}) {
  const t = useTranslations("team.added");
  return (
    <div className="flex flex-col gap-4" data-testid="team-added">
      <p className="flex items-center gap-2 font-strong text-lg text-success">
        <Icon name="success" className="shrink-0" />
        {t("title", { name: added.name })}
      </p>
      {added.suggestedLogin ? (
        <Notice tone="pending">
          {t("login_changed", { suggested: added.suggestedLogin, login: added.login })}
        </Notice>
      ) : null}
      <dl className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <dt className="text-sm text-text-muted">{t("login")}</dt>
          <dd className="break-all font-numeric font-strong text-xl" data-testid="added-login">
            {added.login}
          </dd>
        </div>
        {password ? (
          <div className="flex flex-col gap-1">
            <dt className="text-sm text-text-muted">{t("password")}</dt>
            <dd className="break-all font-numeric font-strong text-xl">{password}</dd>
          </div>
        ) : null}
      </dl>
      {password ? <p className="text-base">{t("password_note", { name: added.name })}</p> : null}
      {added.invite ? (
        <Notice tone={added.invite.queued ? "success" : "pending"} icon="email">
          {added.invite.queued
            ? t("invite_sent", { email: added.invite.email, minutes: added.invite.minutes })
            : t("invite_failed", { email: added.invite.email })}
        </Notice>
      ) : null}
      <div className="flex flex-col gap-3 sm:flex-row">
        {added.shareUrl ? (
          <ShareLink href={added.shareUrl} name={added.name} variant="primary" />
        ) : null}
        <Button
          variant={added.shareUrl ? "secondary" : "primary"}
          size="lg"
          icon="success"
          onClick={onDone}
        >
          {t("done")}
        </Button>
      </div>
    </div>
  );
}

function LanguageChoice({
  value,
  onChange,
}: {
  value: "hi" | "en";
  onChange: (value: "hi" | "en") => void;
}) {
  const t = useTranslations("team.form");
  const common = useTranslations("common");
  const labelId = useId();
  return (
    <div className="flex flex-col gap-2">
      <span id={labelId} className="font-strong text-base">
        {t("language")}
      </span>
      <RadioCards
        aria-labelledby={labelId}
        value={value}
        onValueChange={(next) => onChange(next === "en" ? "en" : "hi")}
        className="grid-cols-2"
        options={[
          { value: "hi", label: common("language_hindi"), icon: "language" },
          { value: "en", label: common("language_english"), icon: "language" },
        ]}
      />
    </div>
  );
}

export interface AddLinemanInputValues {
  name: string;
  mobile: string;
  login: string;
  password: string;
  language: string;
}

/** "Add lineman": name, mobile, user name (= mobile unless changed), password, app language. */
export function AddLinemanDialog({
  open,
  onOpenChange,
  rules,
  suggestion,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rules: PasswordRules;
  suggestion: string;
  onSave: (values: AddLinemanInputValues) => Promise<AddResult>;
}) {
  const t = useTranslations("team.form");
  const common = useTranslations("common");
  const id = useId();
  const [name, setName] = useState("");
  const [mobile, setMobile] = useState("");
  const [login, setLogin] = useState("");
  const [loginEdited, setLoginEdited] = useState(false);
  const [password, setPassword] = useState("");
  const [language, setLanguage] = useState<"hi" | "en">("hi");
  const [fields, setFields] = useState<FieldErrors>({});
  const [error, setError] = useState<TeamErrorKey | null>(null);
  const [added, setAdded] = useState<AddedView | null>(null);
  const [pending, startTransition] = useTransition();
  const fieldError = useFieldError(fields, rules.linemanMin);
  const clear = (field: TeamField) => {
    setFields(({ [field]: _gone, ...rest }) => rest);
    setError(null);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    startTransition(async () => {
      const result = await onSave({ name, mobile, login, password, language });
      if (result.ok) {
        setAdded(result.added);
      } else {
        setFields(result.fields ?? {});
        setError(result.error ?? null);
      }
    });
  };

  return (
    <Dialog
      title={t("add_lineman_title")}
      closeLabel={common("close")}
      open={open}
      onOpenChange={onOpenChange}
    >
      {added ? (
        <AddedSummary added={added} password={password} onDone={() => onOpenChange(false)} />
      ) : (
        <form onSubmit={submit} noValidate className="flex flex-col gap-4">
          <ErrorNotice error={error} />
          <TextField
            id={`${id}-name`}
            name="name"
            label={t("name")}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              clear("name");
            }}
            autoComplete="off"
            maxLength={120}
            error={fieldError("name")}
          />
          <TextField
            id={`${id}-mobile`}
            name="mobile"
            label={t("mobile")}
            value={mobile}
            inputMode="tel"
            autoComplete="off"
            onChange={(e) => {
              const next = e.target.value;
              setMobile(next);
              if (!loginEdited) setLogin(next.replace(/\D/g, "").slice(-10));
              clear("mobile");
              clear("login");
            }}
            error={fieldError("mobile")}
          />
          <TextField
            id={`${id}-login`}
            name="login"
            label={t("login")}
            note={t("login_note")}
            value={login}
            autoCapitalize="none"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => {
              setLogin(e.target.value);
              setLoginEdited(true);
              clear("login");
            }}
            error={fieldError("login")}
          />
          <PasswordInput
            id={`${id}-password`}
            label={t("password")}
            value={password}
            onChange={(value) => {
              setPassword(value);
              clear("password");
            }}
            note={t("password_note_lineman", { min: rules.linemanMin })}
            error={fieldError("password")}
            defaultVisible
            suggestion={suggestion}
          />
          <LanguageChoice value={language} onChange={setLanguage} />
          <Button type="submit" size="lg" icon="add" loading={pending} loadingLabel={t("saving")}>
            {t("add_lineman_submit")}
          </Button>
        </form>
      )}
    </Dialog>
  );
}

export interface AddStaffInputValues {
  name: string;
  mobile: string;
  email: string;
  login: string;
  setup: "password" | "invite";
  password: string;
  language: string;
}

/** "Add staff": name, mobile, email, user name, and how they get a password. */
export function AddStaffDialog({
  open,
  onOpenChange,
  rules,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rules: PasswordRules;
  onSave: (values: AddStaffInputValues) => Promise<AddResult>;
}) {
  const t = useTranslations("team.form");
  const common = useTranslations("common");
  const id = useId();
  const setupLabel = useId();
  const [name, setName] = useState("");
  const [mobile, setMobile] = useState("");
  const [email, setEmail] = useState("");
  const [login, setLogin] = useState("");
  const [loginEdited, setLoginEdited] = useState(false);
  const [setup, setSetup] = useState<"password" | "invite">("password");
  const [password, setPassword] = useState("");
  const [fields, setFields] = useState<FieldErrors>({});
  const [error, setError] = useState<TeamErrorKey | null>(null);
  const [added, setAdded] = useState<AddedView | null>(null);
  const [pending, startTransition] = useTransition();
  const fieldError = useFieldError(fields, rules.staffMin);
  const clear = (field: TeamField) => {
    setFields(({ [field]: _gone, ...rest }) => rest);
    setError(null);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    startTransition(async () => {
      const result = await onSave({
        name,
        mobile,
        email,
        login,
        setup,
        password: setup === "password" ? password : "",
        language: "en",
      });
      if (result.ok) {
        setAdded(result.added);
      } else {
        setFields(result.fields ?? {});
        setError(result.error ?? null);
      }
    });
  };

  return (
    <Dialog
      title={t("add_staff_title")}
      closeLabel={common("close")}
      open={open}
      onOpenChange={onOpenChange}
    >
      {added ? (
        <AddedSummary
          added={added}
          password={setup === "password" ? password : null}
          onDone={() => onOpenChange(false)}
        />
      ) : (
        <form onSubmit={submit} noValidate className="flex flex-col gap-4">
          <ErrorNotice error={error} />
          <TextField
            id={`${id}-name`}
            name="name"
            label={t("name")}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              clear("name");
            }}
            autoComplete="off"
            maxLength={120}
            error={fieldError("name")}
          />
          <TextField
            id={`${id}-mobile`}
            name="mobile"
            label={t("mobile_optional")}
            value={mobile}
            inputMode="tel"
            autoComplete="off"
            onChange={(e) => {
              const next = e.target.value;
              setMobile(next);
              if (!loginEdited) setLogin(next.replace(/\D/g, "").slice(-10));
              clear("mobile");
              clear("login");
            }}
            error={fieldError("mobile")}
          />
          <TextField
            id={`${id}-email`}
            name="email"
            type="email"
            label={t("email_optional")}
            value={email}
            autoComplete="off"
            onChange={(e) => {
              setEmail(e.target.value);
              clear("email");
            }}
            error={fieldError("email")}
          />
          <TextField
            id={`${id}-login`}
            name="login"
            label={t("login")}
            note={t("login_note")}
            value={login}
            autoCapitalize="none"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => {
              setLogin(e.target.value);
              setLoginEdited(true);
              clear("login");
            }}
            error={fieldError("login")}
          />
          <div className="flex flex-col gap-2">
            <span id={setupLabel} className="font-strong text-base">
              {t("setup")}
            </span>
            <RadioCards
              aria-labelledby={setupLabel}
              value={setup}
              onValueChange={(next) => {
                setSetup(next === "invite" ? "invite" : "password");
                clear("password");
                clear("email");
              }}
              options={[
                { value: "password", label: t("setup_password"), icon: "password" },
                {
                  value: "invite",
                  label: t("setup_invite"),
                  description: t("setup_invite_note"),
                  icon: "email",
                },
              ]}
            />
          </div>
          {setup === "password" ? (
            <PasswordInput
              id={`${id}-password`}
              label={t("password")}
              value={password}
              onChange={(value) => {
                setPassword(value);
                clear("password");
              }}
              note={t("password_note_staff", { min: rules.staffMin })}
              error={fieldError("password")}
              defaultVisible
            />
          ) : null}
          <Button type="submit" size="lg" icon="add" loading={pending} loadingLabel={t("saving")}>
            {t("add_staff_submit")}
          </Button>
        </form>
      )}
    </Dialog>
  );
}

/** "New password": the Owner types it (or makes one); every phone/browser of the person signs out. */
export function NewPasswordDialog({
  member,
  open,
  onOpenChange,
  rules,
  suggestion,
  onSave,
}: {
  member: { id: string; name: string; role: "staff" | "lineman" };
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rules: PasswordRules;
  suggestion: string;
  onSave: (userId: string, password: string) => Promise<DoneResult>;
}) {
  const t = useTranslations("team.reset");
  const form = useTranslations("team.form");
  const common = useTranslations("common");
  const addedT = useTranslations("team.added");
  const id = useId();
  const lineman = member.role === "lineman";
  const min = lineman ? rules.linemanMin : rules.staffMin;
  const [password, setPassword] = useState("");
  const [fields, setFields] = useState<FieldErrors>({});
  const [error, setError] = useState<TeamErrorKey | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();
  const fieldError = useFieldError(fields, min);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    startTransition(async () => {
      const result = await onSave(member.id, password);
      if (result.ok) {
        setSaved(true);
      } else {
        setFields(result.fields ?? {});
        setError(result.error ?? null);
      }
    });
  };

  return (
    <Dialog
      title={t("title", { name: member.name })}
      closeLabel={common("close")}
      open={open}
      onOpenChange={onOpenChange}
    >
      {saved ? (
        <div className="flex flex-col gap-4" data-testid="password-saved">
          <p className="flex items-center gap-2 font-strong text-lg text-success">
            <Icon name="success" className="shrink-0" />
            {t("done_title")}
          </p>
          <p className="break-all font-numeric font-strong text-xl">{password}</p>
          <p className="text-base">
            {lineman
              ? t("done_lineman", { name: member.name })
              : t("done_staff", { name: member.name })}
          </p>
          <Button size="lg" icon="success" onClick={() => onOpenChange(false)}>
            {addedT("done")}
          </Button>
        </div>
      ) : (
        <form onSubmit={submit} noValidate className="flex flex-col gap-4">
          <ErrorNotice error={error} />
          <p className="text-base">
            {lineman
              ? t("note_lineman", { name: member.name })
              : t("note_staff", { name: member.name })}
          </p>
          <PasswordInput
            id={`${id}-password`}
            label={form("password")}
            value={password}
            onChange={(value) => {
              setPassword(value);
              setFields({});
              setError(null);
            }}
            note={
              lineman
                ? form("password_note_lineman", { min })
                : form("password_note_staff", { min })
            }
            error={fieldError("password")}
            defaultVisible
            {...(lineman ? { suggestion } : {})}
          />
          <Button
            type="submit"
            size="lg"
            icon="password"
            loading={pending}
            loadingLabel={form("saving")}
          >
            {t("submit")}
          </Button>
        </form>
      )}
    </Dialog>
  );
}
