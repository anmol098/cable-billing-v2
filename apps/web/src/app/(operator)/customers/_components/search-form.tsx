"use client";

/**
 * The customer list's search box and filters (PLAN §12.1: search by code / name / phone / VC,
 * filter by area and status). A plain GET form, so it works without JavaScript; with JavaScript
 * the list updates while typing (after a short pause) and when a filter changes. The search text
 * stays in the URL (`?q=…&area=…&status=…`), so Back and shared links keep it.
 */
import { Button, Icon, Input, Select } from "@cb/ui";
import { usePathname, useRouter } from "next/navigation";
import { type FormEvent, useEffect, useRef, useTransition } from "react";
import { FIELD_LIMITS } from "./limits";
import { searchHref } from "./search-href";

/** Pause after the last key before searching (ms). */
export const SEARCH_DEBOUNCE_MS = 350;

export interface SearchFormLabels {
  search: string;
  placeholder: string;
  button: string;
  area: string;
  areaAll: string;
  areaNone: string;
  status: string;
  statusAll: string;
  statusActive: string;
  statusInactive: string;
}

export interface SearchFormProps {
  q: string;
  area: string;
  status: string;
  areas: readonly { id: string; name: string }[];
  labels: SearchFormLabels;
}

export function CustomerSearchForm({ q, area, status, areas, labels }: SearchFormProps) {
  const router = useRouter();
  const pathname = usePathname();
  const form = useRef<HTMLFormElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [pending, startTransition] = useTransition();

  useEffect(() => () => clearTimeout(timer.current), []);

  const go = () => {
    if (!form.current) return;
    const data = new FormData(form.current);
    const values = {
      q: String(data.get("q") ?? ""),
      area: String(data.get("area") ?? ""),
      status: String(data.get("status") ?? ""),
    };
    startTransition(() => router.replace(searchHref(pathname, values), { scroll: false }));
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    clearTimeout(timer.current);
    go();
  };

  return (
    <search>
      <form
        ref={form}
        method="get"
        action={pathname}
        onSubmit={onSubmit}
        className="flex flex-col gap-3"
        aria-busy={pending || undefined}
      >
        <label htmlFor="customer-search" className="font-strong text-base">
          {labels.search}
        </label>
        <div className="flex gap-2">
          <div className="relative min-w-0 flex-1">
            <Icon
              name="search"
              className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-text-muted"
            />
            <Input
              id="customer-search"
              name="q"
              type="search"
              defaultValue={q}
              placeholder={labels.placeholder}
              maxLength={FIELD_LIMITS.query}
              autoComplete="off"
              spellCheck={false}
              enterKeyHint="search"
              className="pl-10 text-lg"
              onChange={() => {
                clearTimeout(timer.current);
                timer.current = setTimeout(go, SEARCH_DEBOUNCE_MS);
              }}
            />
          </div>
          <Button type="submit" icon="search" loading={pending} className="shrink-0">
            {labels.button}
          </Button>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <label htmlFor="customer-area" className="text-sm text-text-muted">
              {labels.area}
            </label>
            <Select id="customer-area" name="area" defaultValue={area} onChange={go}>
              <option value="">{labels.areaAll}</option>
              <option value="none">{labels.areaNone}</option>
              {areas.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <label htmlFor="customer-status" className="text-sm text-text-muted">
              {labels.status}
            </label>
            <Select id="customer-status" name="status" defaultValue={status} onChange={go}>
              <option value="">{labels.statusAll}</option>
              <option value="active">{labels.statusActive}</option>
              <option value="inactive">{labels.statusInactive}</option>
            </Select>
          </div>
        </div>
      </form>
    </search>
  );
}
