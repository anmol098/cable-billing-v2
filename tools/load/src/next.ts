/**
 * Talking to Next.js pages the way a browser does, without a browser.
 *
 * - **Sign-in** posts the login form exactly as a browser without JavaScript would (React's
 *   progressive enhancement: the form's hidden `$ACTION_*` fields + `login` + `password`, multipart,
 *   same Origin). The server runs the real sign-in action (rate limits included) and answers
 *   303 + the session cookie.
 * - **Counter payments** call the page's Server Actions the way the page's JavaScript does:
 *   `POST <page>` with `Next-Action: <id>` and the arguments as a JSON array. The action ids are
 *   read from the page's own RSC payload (the `$h` server references of the client component's
 *   props), so nothing is hard-coded per build.
 *
 * Both depend on Next.js internals (16.x). If a Next upgrade changes them, these functions throw a
 * `NextProtocolError` saying what was not found, and the scenario reports it as an error instead of
 * measuring the wrong thing.
 */

export class NextProtocolError extends Error {
  override readonly name = "NextProtocolError";
}

function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name}="([^"]*)"`, "i").exec(tag);
  return match?.[1] === undefined ? undefined : decodeEntities(match[1]);
}

/** The `<form>` elements of a page: their hidden inputs and the names of their other inputs. */
export interface ParsedForm {
  readonly hidden: ReadonlyArray<readonly [string, string]>;
  readonly fieldNames: readonly string[];
}

export function parseForms(html: string): ParsedForm[] {
  const forms: ParsedForm[] = [];
  for (const match of html.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/gi)) {
    const body = match[1] ?? "";
    const hidden: Array<[string, string]> = [];
    const fieldNames: string[] = [];
    for (const input of body.matchAll(/<input\b[^>]*>/gi)) {
      const tag = input[0];
      const name = attribute(tag, "name");
      if (!name) continue;
      if (attribute(tag, "type") === "hidden") hidden.push([name, attribute(tag, "value") ?? ""]);
      else fieldNames.push(name);
    }
    forms.push({ hidden, fieldNames });
  }
  return forms;
}

/**
 * The multipart body a JavaScript-less browser sends for the form that has every field in
 * `fields` (e.g. `login` + `password`).
 */
export function formSubmission(html: string, fields: Readonly<Record<string, string>>): FormData {
  const wanted = Object.keys(fields);
  const form = parseForms(html).find((candidate) =>
    wanted.every((name) => candidate.fieldNames.includes(name)),
  );
  if (!form) {
    throw new NextProtocolError(`no form with the fields ${wanted.join(", ")} on the page`);
  }
  if (!form.hidden.some(([name]) => name.startsWith("$ACTION_"))) {
    throw new NextProtocolError("the form has no Server Action fields ($ACTION_*)");
  }
  const data = new FormData();
  for (const [name, value] of form.hidden) data.append(name, value);
  for (const [name, value] of Object.entries(fields)) data.append(name, value);
  return data;
}

/** The RSC payload streamed inside the HTML (`self.__next_f.push([1, "…"])` chunks), joined. */
export function flightPayload(html: string): string {
  let payload = "";
  for (const match of html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)) {
    try {
      payload += JSON.parse(match[1] ?? '""') as string;
    } catch {
      // A chunk we can't decode is skipped; the lookup below fails loudly if it mattered.
    }
  }
  return payload;
}

/**
 * The Server Action id passed to a client component as the prop `prop` (e.g. `takePayment`):
 * the prop is a `"$h<row>"` reference, and row `<row>` is `{"id":"<action id>","bound":null}`.
 */
export function actionIdForProp(html: string, prop: string): string {
  const payload = flightPayload(html);
  const ref = new RegExp(`"${prop}":"\\$h([0-9a-f]+)"`).exec(payload)?.[1];
  if (!ref) throw new NextProtocolError(`no server action passed as "${prop}" on the page`);
  const row = new RegExp(`(?:^|\\n)${ref}:\\{"id":"([0-9a-f]+)","bound":null\\}`).exec(payload);
  const id = row?.[1];
  if (!id)
    throw new NextProtocolError(`server action reference $h${ref} for "${prop}" not resolved`);
  return id;
}

/** Headers for calling a Server Action from "the page" at `origin`. */
export function actionHeaders(origin: string, actionId: string): Record<string, string> {
  return {
    "next-action": actionId,
    accept: "text/x-component",
    "content-type": "text/plain;charset=UTF-8",
    origin,
  };
}

/**
 * The action's return value from its RSC answer: row `0` is `{"a":"$@1",…}`, and the referenced
 * row holds the JSON value.
 */
export function actionResult<T>(flight: string): T | undefined {
  const rows = new Map<string, string>();
  for (const line of flight.split("\n")) {
    const colon = line.indexOf(":");
    if (colon > 0) rows.set(line.slice(0, colon), line.slice(colon + 1));
  }
  try {
    const head = JSON.parse(rows.get("0") ?? "null") as { a?: unknown } | null;
    if (typeof head?.a !== "string") return undefined;
    if (!head.a.startsWith("$@")) return JSON.parse(JSON.stringify(head.a)) as T;
    const row = rows.get(head.a.slice(2));
    return row === undefined ? undefined : (JSON.parse(row) as T);
  } catch {
    return undefined;
  }
}
