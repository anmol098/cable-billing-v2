/**
 * A tiny, strict XML scanner for the few SpreadsheetML parts the import reads (T-084).
 *
 * It is deliberately small: elements, attributes, text, CDATA, comments and processing
 * instructions. A `<!DOCTYPE …>` is refused, so there is no entity expansion ("billion laughs")
 * and no external entities; only the five predefined entities and numeric character references
 * are decoded. Namespace prefixes are dropped (`x:c` → `c`), which is how SpreadsheetML is read
 * in practice. Malformed markup throws {@link XmlError}; the caller turns that into "we can't
 * read this file".
 */

export class XmlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XmlError";
  }
}

export type XmlAttributes = Readonly<Record<string, string>>;

export interface XmlHandlers {
  open?(name: string, attributes: XmlAttributes, selfClosing: boolean): void;
  close?(name: string): void;
  text?(text: string): void;
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/** Characters XML 1.0 does not allow (C0 controls except tab, newline, carriage return). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
const INVALID_XML_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g;

/** Decodes `&amp;`, `&#123;`, `&#x1F;` … An unknown entity is an error (no DTD is allowed). */
export function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&([^;&\s]{1,10});/g, (_match, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      return codePoint(Number.parseInt(body.slice(2), 16));
    }
    if (body.startsWith("#")) return codePoint(Number.parseInt(body.slice(1), 10));
    const named = NAMED_ENTITIES[body];
    if (named === undefined) throw new XmlError("unknown entity");
    return named;
  });
}

function codePoint(value: number): string {
  if (!Number.isInteger(value) || value < 0 || value > 0x10ffff) {
    throw new XmlError("bad character reference");
  }
  return String.fromCodePoint(value);
}

/** Escapes text for an XML text node or attribute value and drops characters XML can't hold. */
export function escapeXml(text: string): string {
  return text
    .replace(INVALID_XML_CHARS, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function localName(name: string): string {
  const colon = name.indexOf(":");
  return colon === -1 ? name : name.slice(colon + 1);
}

const ATTRIBUTE = /([^\s=/]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function parseAttributes(source: string): XmlAttributes {
  const attributes: Record<string, string> = {};
  ATTRIBUTE.lastIndex = 0;
  for (let match = ATTRIBUTE.exec(source); match; match = ATTRIBUTE.exec(source)) {
    const name = match[1] ?? "";
    // `xml:space` keeps its prefix; other prefixes (`r:id`) are kept too, so `r:id` stays distinct.
    attributes[name] = decodeEntities(match[2] ?? match[3] ?? "");
  }
  return attributes;
}

/** The index of the `>` that ends the tag starting before `from` (a `>` inside quotes doesn't). */
function tagEnd(xml: string, from: number): number {
  let quote = "";
  for (let index = from; index < xml.length; index += 1) {
    const char = xml[index];
    if (quote) {
      if (char === quote) quote = "";
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ">") {
      return index;
    } else if (char === "<") {
      return -1;
    }
  }
  return -1;
}

/** Scans `xml`, calling the handlers in document order. Throws {@link XmlError} on bad markup. */
export function scanXml(xml: string, handlers: XmlHandlers): void {
  let position = 0;
  const length = xml.length;
  const depth: string[] = [];
  while (position < length) {
    const lt = xml.indexOf("<", position);
    if (lt === -1) {
      if (handlers.text && depth.length > 0) handlers.text(decodeEntities(xml.slice(position)));
      break;
    }
    if (lt > position && handlers.text && depth.length > 0) {
      handlers.text(decodeEntities(xml.slice(position, lt)));
    }
    if (xml.startsWith("<?", lt)) {
      const end = xml.indexOf("?>", lt + 2);
      if (end === -1) throw new XmlError("unterminated processing instruction");
      position = end + 2;
      continue;
    }
    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      if (end === -1) throw new XmlError("unterminated comment");
      position = end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      if (end === -1) throw new XmlError("unterminated CDATA");
      if (handlers.text && depth.length > 0) handlers.text(xml.slice(lt + 9, end));
      position = end + 3;
      continue;
    }
    if (xml.startsWith("<!", lt)) throw new XmlError("DOCTYPE and declarations are not allowed");
    const gt = tagEnd(xml, lt + 1);
    if (gt === -1) throw new XmlError("unterminated tag");
    const inner = xml.slice(lt + 1, gt);
    if (inner.startsWith("/")) {
      const name = localName(inner.slice(1).trim());
      const open = depth.pop();
      if (open !== name) throw new XmlError("mismatched closing tag");
      handlers.close?.(name);
    } else {
      const selfClosing = inner.endsWith("/");
      const body = selfClosing ? inner.slice(0, -1) : inner;
      const space = body.search(/\s/);
      const rawName = space === -1 ? body : body.slice(0, space);
      if (rawName === "") throw new XmlError("empty tag name");
      const name = localName(rawName);
      const attributes = space === -1 ? {} : parseAttributes(body.slice(space));
      handlers.open?.(name, attributes, selfClosing);
      if (selfClosing) handlers.close?.(name);
      else depth.push(name);
    }
    position = gt + 1;
  }
  if (depth.length > 0) throw new XmlError("unclosed element");
}
