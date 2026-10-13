/**
 * Field lengths for the browser (`maxLength`). The same numbers as `CUSTOMER_FIELD_LIMITS` in
 * `@cb/core` (a test checks they match); kept here so client components don't bundle `@cb/core`.
 */
export const FIELD_LIMITS = {
  customerCode: 64,
  name: 120,
  phoneInput: 30,
  address: 300,
  query: 100,
} as const;
