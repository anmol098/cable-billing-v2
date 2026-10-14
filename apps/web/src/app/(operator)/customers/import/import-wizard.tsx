"use client";

/**
 * The import wizard (T-084, PLAN §12.2): 1 Get the form → 2 Upload the file → 3 Check and add,
 * then the result. One job per step, numbers first, every status with icon + colour + word.
 *
 * - Step 2 sends the file to `POST /customers/import/check` (read + preview on the server) and
 *   stays on the step with the problem in words when the whole file can't be used.
 * - Step 3 shows how many customers are ready / already in the app / have a problem, and every
 *   line with what to fix. "Add N customers" sends the ready customers in steps (whole customers,
 *   ≤ 250 lines, two at a time) to `importStepAction`, with progress; leaving the page asks first.
 * - The result: what was added, what was skipped, and the "lines with problems" file (Excel or
 *   CSV) to fix and upload again. A stopped import says to upload the same file again.
 */
import type { ImportLine, ImportLineResult } from "@cb/core";
import type { Locale } from "@cb/i18n";
import { Button, Card, Icon, type IconName, Input, Stepper } from "@cb/ui";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { countCustomers, downloadProblemFile, mergeResults, runSteps } from "./_lib/run";
import type { CheckError, CheckResponse, ImportFileKind, StepResponse } from "./_lib/types";
import { FIELD_KEY, type ImportWords } from "./_lib/words";
import { type LineFilter, type LineRow, LinesTable } from "./_parts/lines-table";

export interface ImportWizardProps {
  importStep: (lines: ImportLine[]) => Promise<StepResponse>;
  /** The language the "other" template link uses. */
  otherLanguage: Locale;
  limits: { rows: number; megabytes: number; fileBytes: number; parallelSteps: number };
}

type Checked = Extract<CheckResponse, { ok: true }>;
type Phase = "preview" | "importing" | "done";

const UPLOAD_STEP = 1;

/** One count with its icon and colour; `extra` follows in a quieter colour. */
function SummaryLine({
  icon,
  tone,
  children,
  extra,
}: {
  icon: IconName;
  tone: string;
  children: ReactNode;
  extra?: ReactNode;
}) {
  return (
    <li className="flex items-start gap-3 text-lg">
      <Icon name={icon} className={`mt-1 size-6 shrink-0 ${tone}`} />
      <span className="flex flex-wrap gap-x-3">
        <span className="font-strong">{children}</span>
        {extra ? <span className="text-text-muted">{extra}</span> : null}
      </span>
    </li>
  );
}

export function ImportWizard({ importStep, otherLanguage, limits }: ImportWizardProps) {
  const raw = useTranslations("import");
  const t = raw as unknown as ImportWords;
  const common = useTranslations("common");
  const [step, setStep] = useState(0);
  const [file, setFile] = useState<File | null>(null);
  const [inputKey, setInputKey] = useState(0);
  const [fileError, setFileError] = useState<CheckError | null>(null);
  const [checked, setChecked] = useState<Checked | null>(null);
  const [results, setResults] = useState<Map<number, ImportLineResult>>(new Map());
  const [phase, setPhase] = useState<Phase>("preview");
  const [stopped, setStopped] = useState<"stopped" | "read_only" | null>(null);
  const [downloadFailed, setDownloadFailed] = useState(false);
  /** Customers ready when "Add" was pressed (the progress total). */
  const [importTotal, setImportTotal] = useState(0);

  // Leaving the page while customers are being added would stop the import half way.
  useEffect(() => {
    if (phase !== "importing") return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [phase]);

  const rows: LineRow[] = useMemo(() => {
    if (!checked) return [];
    return checked.lines.flatMap((line) => {
      const result = results.get(line.line);
      return result ? [{ line, result }] : [];
    });
  }, [checked, results]);
  const counts = useMemo(() => countCustomers(rows.map((row) => row.result)), [rows]);
  const problemRows = rows.filter((row) => row.result.status === "problem");

  const reset = () => {
    setFile(null);
    setInputKey((key) => key + 1);
    setFileError(null);
    setChecked(null);
    setResults(new Map());
    setPhase("preview");
    setStopped(null);
    setDownloadFailed(false);
  };

  const fileErrorText = (error: CheckError): string => {
    const columns = (error.fields ?? []).map((field) => t(`field.${FIELD_KEY[field]}`)).join(", ");
    return t(`file_error.${error.code}`, {
      size: limits.megabytes,
      rows: limits.rows.toLocaleString("en-IN"),
      columns,
    });
  };

  const checkFile = async (): Promise<boolean> => {
    setFileError(null);
    if (!file) {
      setFileError({ code: "no_file" });
      return false;
    }
    if (file.size > limits.fileBytes) {
      setFileError({ code: "too_big" });
      return false;
    }
    const body = new FormData();
    body.append("file", file);
    let response: CheckResponse;
    try {
      const reply = await fetch("/customers/import/check", { method: "POST", body });
      response = (await reply.json()) as CheckResponse;
    } catch {
      setFileError({ code: "unexpected" });
      return false;
    }
    if (!response.ok) {
      setFileError(response.error);
      return false;
    }
    setChecked(response);
    setResults(new Map(response.preview.lines.map((result) => [result.line, result])));
    setPhase("preview");
    setStopped(null);
    return true;
  };

  const runImport = async () => {
    if (!checked) return;
    setImportTotal(countCustomers([...results.values()]).customers.ready);
    setPhase("importing");
    const lines = new Map(checked.lines.map((line) => [line.line, line]));
    const outcome = await runSteps({
      steps: checked.preview.steps,
      lines,
      parallel: limits.parallelSteps,
      importStep,
      onStep: (stepResults) => setResults((current) => mergeResults(current, stepResults)),
    });
    setStopped(outcome === "ok" ? null : outcome);
    setPhase("done");
  };

  const download = async (kind: ImportFileKind) => {
    setDownloadFailed(false);
    const ok = await downloadProblemFile(kind, problemRows).catch(() => false);
    if (!ok) setDownloadFailed(true);
  };

  const problemDownloads =
    problemRows.length > 0 ? (
      <Card className="flex flex-col gap-3">
        <h3 className="font-strong text-lg">{t("check.problems_title")}</h3>
        <p className="text-text-muted">{t("check.problems_hint")}</p>
        <div className="flex flex-wrap gap-3">
          <Button
            type="button"
            variant="secondary"
            icon="export"
            onClick={() => void download("xlsx")}
          >
            {t("check.download_excel")}
          </Button>
          <Button
            type="button"
            variant="secondary"
            icon="export"
            onClick={() => void download("csv")}
          >
            {t("check.download_csv")}
          </Button>
        </div>
        {downloadFailed ? (
          <p role="alert" className="text-danger">
            {t("check.download_failed")}
          </p>
        ) : null}
      </Card>
    ) : null;

  const warnings = checked ? (
    <>
      {checked.file.warnings.includes("not_utf8") ? (
        <p role="note" className="flex items-start gap-2 text-pending">
          <Icon name="pending" className="mt-1 shrink-0" />
          {t("warning.not_utf8")}
        </p>
      ) : null}
      {checked.file.unusedColumns.length > 0 ? (
        <p className="text-text-muted">
          {t("warning.unused_columns", { columns: checked.file.unusedColumns.join(", ") })}
        </p>
      ) : null}
    </>
  ) : null;

  if (checked && phase === "done") {
    return (
      <section className="flex flex-col gap-6" aria-labelledby="import-done">
        <h2 id="import-done" tabIndex={-1} className="font-strong text-xl">
          {t("done.title")}
        </h2>
        <ul className="flex flex-col gap-2" aria-live="polite">
          <SummaryLine
            icon="success"
            tone="text-success"
            extra={
              counts.connections > 0
                ? t("summary.created_connections", { count: counts.connections })
                : null
            }
          >
            {t("summary.created", { count: counts.customers.created })}
          </SummaryLine>
          {counts.customers.exists > 0 ? (
            <SummaryLine icon="close" tone="text-text-muted">
              {t("summary.exists", { count: counts.customers.exists })}
            </SummaryLine>
          ) : null}
          {counts.customers.problem > 0 ? (
            <SummaryLine icon="danger" tone="text-danger">
              {t("summary.problem", { count: counts.customers.problem })}
            </SummaryLine>
          ) : null}
        </ul>
        {stopped ? (
          <p role="alert" className="text-danger">
            {stopped === "read_only" ? t("file_error.read_only") : t("done.stopped")}
          </p>
        ) : null}
        {problemDownloads}
        <LinesTable rows={rows} initialFilter={problemRows.length > 0 ? "problem" : "all"} done />
        <div className="flex flex-col gap-3 sm:flex-row">
          <Button asChild size="lg" icon="customer">
            <Link href="/customers">{t("done.open_customers")}</Link>
          </Button>
          <Button
            type="button"
            size="lg"
            variant="secondary"
            icon="import"
            onClick={() => {
              reset();
              setStep(UPLOAD_STEP);
            }}
          >
            {t("done.again")}
          </Button>
        </div>
      </section>
    );
  }

  const ready = counts.customers.ready;
  const otherHref = (format: ImportFileKind) =>
    `/customers/import/template?format=${format}&lang=${otherLanguage}`;

  return (
    <Stepper
      step={step}
      onStepChange={setStep}
      backLabel={common("back")}
      nextLabel={step === UPLOAD_STEP ? t("upload.check") : common("next")}
      finishType="button"
      finishLabel={ready > 0 ? t("check.add", { count: ready }) : t("check.upload_again")}
      finishIcon={ready > 0 ? "add" : "import"}
      finishing={phase === "importing"}
      finishingLabel={t("check.adding")}
      progressLabel={(current, total) => t("progress", { current, total })}
      onNext={async (current) => (current === UPLOAD_STEP ? checkFile() : true)}
      onFinish={async () => {
        if (ready > 0) {
          await runImport();
        } else {
          reset();
          setStep(UPLOAD_STEP);
        }
      }}
      steps={[
        {
          id: "get",
          title: t("step.get"),
          content: (
            <div className="flex flex-col gap-5">
              <p className="text-lg">{t("get.lead")}</p>
              <div className="flex flex-col gap-3 sm:flex-row">
                <Button asChild size="lg" icon="export">
                  <a href="/customers/import/template?format=xlsx" download>
                    {t("get.excel")}
                  </a>
                </Button>
                <Button asChild size="lg" variant="secondary" icon="export">
                  <a href="/customers/import/template?format=csv" download>
                    {t("get.csv")}
                  </a>
                </Button>
              </div>
              <p className="flex flex-wrap items-center gap-x-3 text-text-muted">
                {t("get.other_language")}
                <a className="underline underline-offset-4" href={otherHref("xlsx")} download>
                  {t("get.other_excel")}
                </a>
                <a className="underline underline-offset-4" href={otherHref("csv")} download>
                  {t("get.other_csv")}
                </a>
              </p>
              <div className="flex flex-col gap-2">
                <h3 className="font-strong text-lg">{t("get.rules_title")}</h3>
                <ul className="flex list-disc flex-col gap-1 ps-6">
                  {[
                    "rule_line",
                    "rule_needed",
                    "rule_plan",
                    "rule_date",
                    "rule_area",
                    "rule_again",
                  ].map((key) => (
                    <li key={key}>{t(`get.${key}`)}</li>
                  ))}
                </ul>
                <p className="text-text-muted">
                  {t("get.limits", {
                    rows: limits.rows.toLocaleString("en-IN"),
                    size: limits.megabytes,
                  })}
                </p>
              </div>
            </div>
          ),
        },
        {
          id: "upload",
          title: t("step.upload"),
          content: (
            <div className="flex flex-col gap-3">
              <label htmlFor="import-file" className="font-strong text-lg">
                {t("upload.label")}
              </label>
              <Input
                key={inputKey}
                id="import-file"
                name="file"
                type="file"
                accept=".xlsx,.csv,.txt,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
                invalid={fileError !== null}
                aria-describedby={fileError ? "import-file-error" : undefined}
                onChange={(event) => {
                  setFile(event.currentTarget.files?.[0] ?? null);
                  setFileError(null);
                }}
              />
              {file ? (
                <p className="text-text-muted">
                  {t("upload.chosen", {
                    name: file.name,
                    size: Math.max(1, Math.round(file.size / 1024)).toLocaleString("en-IN"),
                  })}
                </p>
              ) : null}
              {fileError ? (
                <p
                  id="import-file-error"
                  role="alert"
                  className="flex items-start gap-2 text-danger"
                >
                  <Icon name="danger" className="mt-1 shrink-0" />
                  {fileErrorText(fileError)}
                </p>
              ) : null}
            </div>
          ),
        },
        {
          id: "check",
          title: t("step.check"),
          content: checked ? (
            <div className="flex flex-col gap-5">
              <ul className="flex flex-col gap-2">
                <SummaryLine
                  icon="add"
                  tone="text-pending"
                  extra={
                    counts.connections > 0
                      ? t("summary.connections", { count: counts.connections })
                      : null
                  }
                >
                  {t("summary.ready", { count: ready })}
                </SummaryLine>
                {counts.customers.exists > 0 ? (
                  <SummaryLine icon="close" tone="text-text-muted">
                    {t("summary.exists", { count: counts.customers.exists })}
                  </SummaryLine>
                ) : null}
                {counts.customers.problem > 0 ? (
                  <SummaryLine icon="danger" tone="text-danger">
                    {t("summary.problem", { count: counts.customers.problem })}
                  </SummaryLine>
                ) : null}
              </ul>
              {warnings}
              {phase === "importing" ? (
                <p aria-live="polite" className="font-strong text-lg">
                  {t("check.progress", {
                    done: Math.max(0, importTotal - ready).toLocaleString("en-IN"),
                    total: importTotal.toLocaleString("en-IN"),
                  })}
                </p>
              ) : null}
              {problemDownloads}
              <LinesTable
                key={checked.file.name}
                rows={rows}
                initialFilter={(problemRows.length > 0 ? "problem" : "all") as LineFilter}
                done={false}
              />
            </div>
          ) : null,
        },
      ]}
    />
  );
}
