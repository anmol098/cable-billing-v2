/**
 * The columns of the customer import file (T-084) and how a header cell is recognised.
 *
 * One line per connection (set-top box). A customer with two boxes is two lines with the same
 * customer code; a customer without a box is one line with the VC columns empty.
 *
 * Headers are matched loosely: case, spaces, punctuation, `*` and `(₹)` are ignored, so
 * "Customer code *", "customer-code" and "CUSTOMER CODE" are the same column; English and Hindi
 * names both work, plus common words operators use in their own sheets ("Mobile", "STB no",
 * "Package"). The template's own headers come from the i18n namespace `import`
 * (`template.columns.*`); a web test checks that every one of them, in both languages, is
 * recognised here.
 */

/** The fields of one line, in template order. */
export const IMPORT_FIELDS = [
  "code",
  "name",
  "phone",
  "altPhone",
  "address",
  "area",
  "vcNumber",
  "plan",
  "rent",
  "startDate",
] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];

/** Fields every file must have a column for. */
export const REQUIRED_IMPORT_FIELDS: readonly ImportField[] = ["code", "name"];

/** Columns our own problem file adds ("Line", "Problem"): recognised and ignored on upload. */
export const IGNORED_COLUMN = "ignore" as const;

/** A header cell → its matching key: lower case, letters/digits/marks only (any script). */
export function headerKey(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]/gu, "");
}

const ALIASES: Readonly<Record<ImportField | typeof IGNORED_COLUMN, readonly string[]>> = {
  code: [
    "Customer code",
    "Code",
    "Cust code",
    "Customer no",
    "Customer number",
    "Customer ID",
    "ID",
    "Account no",
    "Account number",
    "ग्राहक कोड",
    "कोड",
    "ग्राहक नंबर",
    "ग्राहक नं",
  ],
  name: [
    "Name",
    "Customer name",
    "Full name",
    "Customer",
    "नाम",
    "ग्राहक का नाम",
    "ग्राहक नाम",
    "ग्राहक",
  ],
  phone: [
    "Mobile no",
    "Mobile",
    "Mobile number",
    "Phone",
    "Phone no",
    "Phone number",
    "Contact",
    "Contact no",
    "Contact number",
    "मोबाइल नंबर",
    "मोबाइल नं",
    "मोबाइल",
    "फ़ोन",
    "फोन",
    "फ़ोन नंबर",
    "फोन नंबर",
  ],
  altPhone: [
    "Other mobile no",
    "Other mobile",
    "Other mobile number",
    "Other phone",
    "Alternate phone",
    "Alternate mobile",
    "Alt phone",
    "Alt mobile",
    "Mobile 2",
    "Phone 2",
    "Second mobile",
    "दूसरा मोबाइल नंबर",
    "दूसरा मोबाइल नं",
    "दूसरा मोबाइल",
    "दूसरा फ़ोन",
    "दूसरा फोन",
  ],
  address: ["Address", "Full address", "पता"],
  area: ["Area", "Area name", "Locality", "Zone", "Ward", "एरिया", "क्षेत्र", "इलाका"],
  vcNumber: [
    "VC number",
    "VC no",
    "VC",
    "VC card",
    "Box number",
    "Box no",
    "STB number",
    "STB no",
    "STB",
    "Card number",
    "Card no",
    "Smart card",
    "Smart card no",
    "Smart card number",
    "VC नंबर",
    "VC नं",
    "वीसी नंबर",
    "बॉक्स नंबर",
    "कार्ड नंबर",
  ],
  plan: ["Plan", "Plan name", "Package", "Pack", "प्लान", "प्लान का नाम", "पैकेज"],
  rent: [
    "Rent",
    "Rent per month",
    "Rent (₹ per month)",
    "Monthly rent",
    "Monthly amount",
    "Amount",
    "Rental",
    "Monthly rental",
    "Price",
    "किराया",
    "किराया (₹ हर महीने)",
    "महीने का किराया",
    "रकम",
  ],
  startDate: [
    "Start day",
    "Start date",
    "Start",
    "Starting date",
    "Connection date",
    "Joining date",
    "Date",
    "शुरू का दिन",
    "शुरू की तारीख",
    "कनेक्शन की तारीख",
    "तारीख",
  ],
  ignore: [
    "Line",
    "Line no",
    "Row",
    "Row no",
    "Problem",
    "Problems",
    "Error",
    "What is wrong",
    "लाइन",
    "लाइन नं",
    "पंक्ति",
    "दिक्कत",
    "समस्या",
    "क्या गलत है",
  ],
};

const BY_KEY: ReadonlyMap<string, ImportField | typeof IGNORED_COLUMN> = (() => {
  const map = new Map<string, ImportField | typeof IGNORED_COLUMN>();
  for (const [field, aliases] of Object.entries(ALIASES) as [
    ImportField | typeof IGNORED_COLUMN,
    readonly string[],
  ][]) {
    for (const alias of aliases) {
      const key = headerKey(alias);
      const taken = map.get(key);
      if (taken && taken !== field) throw new Error(`import header alias "${alias}" is ambiguous`);
      map.set(key, field);
    }
  }
  return map;
})();

/** The field a header cell names, `ignore` for our own extra columns, or `null` (unknown). */
export function fieldForHeader(text: string): ImportField | typeof IGNORED_COLUMN | null {
  const key = headerKey(text);
  if (key === "") return null;
  return BY_KEY.get(key) ?? null;
}
