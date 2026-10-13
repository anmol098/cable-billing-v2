"use client";

import type { Locale } from "@cb/i18n";
import {
  Amount,
  AmountInput,
  Button,
  Card,
  Checkbox,
  Combobox,
  type ComboboxOption,
  ConfirmSheet,
  DataTable,
  type DataTableColumn,
  Dialog,
  DialogClose,
  Divider,
  EmptyState,
  formatRupees,
  HelpTip,
  IconButton,
  Input,
  PAGE_ACTION_CLEARANCE,
  PageHeader,
  RadioCards,
  Select,
  Spinner,
  StatusPill,
  Stepper,
  Textarea,
  ToastProvider,
  useToast,
} from "@cb/ui";
import { useFormatter, useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import { LocaleSwitch } from "@/components/locale-switch";
import { SAMPLE_CUSTOMERS, type SampleCustomer, searchSampleCustomers } from "./sample-data";

type Props = {
  locale: Locale;
  /** The `setLocale` server action (cookie + re-render). */
  localeAction: (formData: FormData) => Promise<void>;
  /** The help sentence in the other language, for the bilingual HelpTip. */
  helpTranslation: { text: string; lang: Locale };
};

/** Every primitive and composite with real i18n words (T-007). Development and previews only. */
export function Showcase(props: Props) {
  const common = useTranslations("common");
  const ui = useTranslations("ui");
  return (
    <ToastProvider closeLabel={common("close")} label={ui("notifications")}>
      <ShowcaseBody {...props} />
    </ToastProvider>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={`section-${id}`} data-section={id} className="flex flex-col gap-4">
      <h2 id={`section-${id}`} className="font-strong text-xl">
        {title}
      </h2>
      {children}
    </section>
  );
}

function ShowcaseBody({ locale, localeAction, helpTranslation }: Props) {
  const t = useTranslations("dev_ui");
  const common = useTranslations("common");
  const ui = useTranslations("ui");
  const format = useFormatter();
  const { toast } = useToast();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [chosen, setChosen] = useState<ComboboxOption | null>(null);
  const [amountProblem, setAmountProblem] = useState(false);

  const columns: DataTableColumn<SampleCustomer>[] = [
    { id: "name", header: common("customer"), cell: (row) => row.name, primary: true },
    { id: "area", header: t("table.area"), cell: (row) => row.area },
    {
      id: "status",
      header: t("table.status"),
      cell: (row) =>
        row.active ? (
          <StatusPill variant="success" label={t("table.active")} />
        ) : (
          <StatusPill variant="danger" label={t("table.stopped")} />
        ),
    },
    {
      id: "balance",
      header: common("due"),
      align: "end",
      cell: (row) => (
        <Amount
          paise={row.balancePaise}
          tone="balance"
          dueLabel={common("due")}
          creditLabel={common("credit")}
        />
      ),
    },
  ];

  const stopMonth = format.dateTime(new Date(Date.UTC(2026, 10, 1)), {
    month: "long",
    timeZone: "Asia/Kolkata",
  });

  return (
    <main className={`flex flex-col gap-10 p-4 sm:p-6 ${PAGE_ACTION_CLEARANCE}`}>
      <div className="flex flex-wrap items-center justify-between gap-4">
        {/* LanguageSwitch (EN | हिं) wired to the setLocale cookie action. */}
        <LocaleSwitch current={locale} action={localeAction} />
      </div>

      <PageHeader
        title={t("title")}
        description={t("intro")}
        action={
          <Button
            size="lg"
            icon="add"
            onClick={() => toast({ variant: "success", title: t("add_customer") })}
          >
            {t("add_customer")}
          </Button>
        }
      />

      <Section id="buttons" title={t("sections.buttons")}>
        <div className="flex flex-wrap gap-3">
          <Button icon="collect">{common("collect")}</Button>
          <Button variant="secondary" icon="print">
            {common("print")}
          </Button>
          <Button variant="quiet" icon="back">
            {common("back")}
          </Button>
          <Button variant="danger" icon="danger">
            {t("buttons.stop_connection")}
          </Button>
          <Button size="lg" loading loadingLabel={ui("saving")}>
            {common("save")}
          </Button>
          <Button disabled>{t("buttons.disabled")}</Button>
          <IconButton icon="print" label={common("print")} />
          <IconButton icon="call" label={common("call_office")} showLabel />
        </div>
      </Section>

      <Section id="fields" title={t("sections.fields")}>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <label htmlFor="dev-ui-name" className="font-strong">
              {t("fields.name")}
            </label>
            <Input id="dev-ui-name" placeholder={t("fields.name_hint")} />
          </div>
          <div className="flex flex-col gap-2">
            <label htmlFor="dev-ui-phone" className="font-strong">
              {t("fields.phone")}
            </label>
            <Input
              id="dev-ui-phone"
              inputMode="numeric"
              defaultValue="98765"
              invalid
              aria-describedby="dev-ui-phone-problem"
            />
            <p id="dev-ui-phone-problem" className="text-danger text-sm">
              {t("fields.phone_problem")}
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <label htmlFor="dev-ui-plan" className="font-strong">
              {t("fields.plan")}
            </label>
            <Select id="dev-ui-plan" placeholder={t("fields.plan_choose")} defaultValue="">
              <option value="basic">{t("fields.plan_basic")}</option>
              <option value="sports">{t("fields.plan_sports")}</option>
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <label htmlFor="dev-ui-note" className="font-strong">
              {t("fields.note")}
            </label>
            <Textarea id="dev-ui-note" />
          </div>
          <Checkbox
            label={t("fields.whatsapp_bill")}
            description={t("fields.whatsapp_bill_hint")}
          />
          <div className="flex flex-col gap-2">
            <p id="dev-ui-method" className="font-strong">
              {t("fields.method")}
            </p>
            <RadioCards
              aria-labelledby="dev-ui-method"
              defaultValue="cash"
              className="sm:grid-cols-2"
              options={[
                { value: "cash", label: common("cash"), icon: "cash", iconClassName: "text-cash" },
                { value: "upi", label: common("upi"), icon: "upi", iconClassName: "text-upi" },
              ]}
            />
          </div>
          <div className="flex flex-col gap-2">
            <label htmlFor="dev-ui-amount" className="font-strong">
              {t("fields.amount")}
            </label>
            <AmountInput
              id="dev-ui-amount"
              defaultValue={45_000}
              invalid={amountProblem}
              aria-describedby={amountProblem ? "dev-ui-amount-problem" : undefined}
              onValueChange={() => setAmountProblem(false)}
              onReject={() => setAmountProblem(true)}
            />
            {amountProblem ? (
              <p id="dev-ui-amount-problem" className="text-danger text-sm">
                {t("fields.whole_rupees")}
              </p>
            ) : null}
          </div>
        </div>
      </Section>

      <Section id="numbers" title={t("sections.numbers")}>
        <div className="flex flex-col gap-4">
          <Amount paise={12_345_600} tone="due" size="amount" dueLabel={common("due")} />
          <Amount paise={-5_000} size="xl" creditLabel={common("credit")} />
          <Amount paise={0} tone="balance" size="lg" />
          <div className="flex flex-wrap gap-2">
            <StatusPill variant="cash" label={common("cash")} />
            <StatusPill variant="upi" label={common("upi")} />
            <StatusPill variant="pending" label={common("saved_on_phone")} />
            <StatusPill variant="success" label={common("sent_to_office")} />
            <StatusPill variant="danger" label={common("problem")} />
          </div>
          <Spinner size="md" label={common("loading")} />
        </div>
      </Section>

      <Section id="cards" title={t("sections.cards")}>
        <Card className="flex flex-col gap-3">
          <p className="font-strong text-lg">{t("card.title")}</p>
          <Divider />
          <Amount paise={2_345_600} size="2xl" />
          <p className="text-text-muted">{t("card.text")}</p>
        </Card>
      </Section>

      <Section id="empty" title={t("sections.empty")}>
        <EmptyState
          icon="customer"
          message={t("empty.message")}
          action={<Button icon="add">{t("add_customer")}</Button>}
        />
      </Section>

      <Section id="table" title={t("sections.table")}>
        <DataTable
          caption={t("table.caption")}
          columns={columns}
          rows={SAMPLE_CUSTOMERS}
          rowKey={(row) => row.id}
          onRowClick={(row) =>
            toast({ variant: "success", title: t("table.opened", { name: row.name }) })
          }
        />
      </Section>

      <Section id="dialogs" title={t("sections.dialogs")}>
        <div className="flex flex-wrap gap-3">
          <Dialog
            title={t("dialog.title")}
            description={t("dialog.description")}
            closeLabel={common("close")}
            open={dialogOpen}
            onOpenChange={setDialogOpen}
            trigger={
              <Button variant="secondary" icon="plan">
                {t("dialog.open")}
              </Button>
            }
            footer={
              <>
                <DialogClose asChild>
                  <Button variant="secondary">{common("cancel")}</Button>
                </DialogClose>
                <Button
                  icon="success"
                  onClick={() => {
                    setDialogOpen(false);
                    toast({ variant: "success", title: t("toasts.saved") });
                  }}
                >
                  {common("save")}
                </Button>
              </>
            }
          >
            <div className="flex flex-col gap-2">
              <label htmlFor="dev-ui-dialog-plan" className="font-strong">
                {t("fields.plan")}
              </label>
              <Select id="dev-ui-dialog-plan" defaultValue="basic">
                <option value="basic">{t("fields.plan_basic")}</option>
                <option value="sports">{t("fields.plan_sports")}</option>
              </Select>
            </div>
          </Dialog>
          <ConfirmSheet
            title={t("confirm.title")}
            summary={
              <p>
                {t.rich("confirm.summary", {
                  name: "Ramesh Kumar",
                  vc: "12345",
                  month: stopMonth,
                  amount: formatRupees(45_000).text,
                  b: (chunks) => <strong className="font-strong">{chunks}</strong>,
                })}
              </p>
            }
            confirmLabel={t("buttons.stop_connection")}
            cancelLabel={common("cancel")}
            confirmIcon="danger"
            tone="danger"
            loadingLabel={t("confirm.stopping")}
            onConfirm={async () => {
              await new Promise((resolve) => setTimeout(resolve, 600));
              toast({ variant: "success", title: t("confirm.stopped") });
            }}
            trigger={
              <Button variant="danger" icon="danger">
                {t("buttons.stop_connection")}
              </Button>
            }
          />
        </div>
      </Section>

      <Section id="toasts" title={t("sections.toasts")}>
        <div className="flex flex-wrap gap-3">
          <Button
            variant="secondary"
            icon="success"
            onClick={() => toast({ variant: "success", title: t("toasts.saved") })}
          >
            {t("toasts.show_success")}
          </Button>
          <Button
            variant="secondary"
            icon="pending"
            onClick={() => toast({ variant: "pending", title: common("saved_on_phone") })}
          >
            {t("toasts.show_pending")}
          </Button>
          <Button
            variant="secondary"
            icon="danger"
            onClick={() =>
              toast({
                variant: "danger",
                title: common("problem"),
                description: t("toasts.problem_detail"),
              })
            }
          >
            {t("toasts.show_problem")}
          </Button>
        </div>
      </Section>

      <Section id="stepper" title={t("sections.stepper")}>
        <form
          aria-label={t("sections.stepper")}
          onSubmit={(event) => {
            event.preventDefault();
            toast({ variant: "success", title: t("stepper.saved") });
          }}
        >
          <Stepper
            headingLevel={3}
            backLabel={common("back")}
            nextLabel={common("next")}
            finishLabel={common("save")}
            progressLabel={(current, total) => ui("step_progress", { current, total })}
            steps={[
              {
                id: "customer",
                title: t("stepper.customer"),
                content: (
                  <div className="flex flex-col gap-2">
                    <label htmlFor="dev-ui-step-name" className="font-strong">
                      {t("fields.name")}
                    </label>
                    <Input
                      id="dev-ui-step-name"
                      name="name"
                      required
                      placeholder={t("fields.name_hint")}
                    />
                  </div>
                ),
              },
              {
                id: "connections",
                title: t("stepper.connections"),
                content: (
                  <div className="flex flex-col gap-4">
                    <div className="flex flex-col gap-2">
                      <label htmlFor="dev-ui-step-vc" className="font-strong">
                        {common("vc_number")}
                      </label>
                      <Input id="dev-ui-step-vc" name="vc" inputMode="numeric" />
                    </div>
                    <div className="flex flex-col gap-2">
                      <label htmlFor="dev-ui-step-plan" className="font-strong">
                        {t("fields.plan")}
                      </label>
                      <Select id="dev-ui-step-plan" name="plan" defaultValue="basic">
                        <option value="basic">{t("fields.plan_basic")}</option>
                        <option value="sports">{t("fields.plan_sports")}</option>
                      </Select>
                    </div>
                  </div>
                ),
              },
              {
                id: "check",
                title: t("stepper.check"),
                content: <p>{t("stepper.check_text")}</p>,
              },
            ]}
          />
        </form>
      </Section>

      <Section id="help" title={t("sections.help")}>
        <div className="flex items-center gap-1">
          <span className="font-strong text-lg">{common("due")}</span>
          <HelpTip
            label={ui("help_about", { topic: common("due") })}
            text={t("help.text")}
            translation={helpTranslation}
          />
        </div>
      </Section>

      <Section id="search" title={t("sections.search")}>
        <Combobox
          label={t("search.label")}
          placeholder={t("search.hint")}
          loadOptions={async (query, signal) =>
            (await searchSampleCustomers(query, signal)).map((customer) => ({
              value: customer.id,
              label: customer.name,
              description: `${customer.code} · ${customer.phone} · ${common("vc_number")} ${customer.vc}`,
            }))
          }
          onSelect={setChosen}
          loadingLabel={ui("searching")}
          emptyLabel={t("search.empty")}
          errorLabel={ui("search_failed")}
          resultsLabel={(count) => ui("search_results", { count })}
        />
        {chosen ? <p data-testid="chosen">{t("search.chosen", { name: chosen.label })}</p> : null}
      </Section>
    </main>
  );
}
