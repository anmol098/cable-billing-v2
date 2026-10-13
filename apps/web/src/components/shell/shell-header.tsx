import type { Locale } from "@cb/i18n";
import { useTranslations } from "next-intl";
import { LocaleSwitch } from "@/components/locale-switch";
import { AccountMenu } from "./account-menu";

type FormAction = (formData: FormData) => void | Promise<void>;

/**
 * The top bar of every operator page: the business name (so staff of two cable businesses never
 * mix them up), the language switch (always one tap away, PLAN §2.2 rule 10) and the account menu.
 */
export function ShellHeader({
  operatorName,
  userName,
  userRole,
  locale,
  setLocale,
  signOutAction,
  signOutEverywhereAction,
}: {
  operatorName: string;
  userName: string;
  userRole: "owner" | "staff";
  locale: Locale;
  setLocale: FormAction;
  signOutAction: FormAction;
  signOutEverywhereAction: FormAction;
}) {
  const t = useTranslations("shell.account");
  const auth = useTranslations("auth");
  return (
    <header
      data-shell="header"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b-hairline border-border bg-bg px-4 py-2 md:px-8"
    >
      {/* Phones: the business name gets its own line so it is never cut short. */}
      <p
        className="w-full min-w-0 truncate font-strong text-lg sm:w-auto sm:flex-1"
        data-shell="operator-name"
      >
        {operatorName}
      </p>
      <div className="ml-auto flex shrink-0 items-center gap-3">
        <LocaleSwitch current={locale} action={setLocale} />
        <AccountMenu
          label={t("menu")}
          userName={userName}
          roleLabel={userRole === "owner" ? t("role_owner") : t("role_staff")}
          signOutLabel={auth("sign_out")}
          signOutEverywhereLabel={auth("sign_out_everywhere")}
          signOutAction={signOutAction}
          signOutEverywhereAction={signOutEverywhereAction}
        />
      </div>
    </header>
  );
}
