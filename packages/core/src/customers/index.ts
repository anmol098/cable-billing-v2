/**
 * Customers (T-033): create / edit / deactivate, phone corrections with history, ranked search,
 * the profile summary and form options. See ./customers.ts (writes) and ./queries.ts (reads).
 */
export {
  type CreateCustomerCommand,
  CreateCustomerInput,
  type CustomerActor,
  createCustomer,
  createCustomerInTx,
  isDuplicateCustomerCode,
  SetCustomerStatusInput,
  setCustomerStatus,
  toCustomerView,
  type UpdateCustomerCommand,
  UpdateCustomerInput,
  UpdateCustomerPhoneInput,
  updateCustomer,
  updateCustomerPhone,
} from "./customers";
export {
  CUSTOMER_PAGE_SIZE,
  CustomerFormOptionsInput,
  customerFormOptions,
  customerSearchSql,
  GetCustomerInput,
  getCustomer,
  MAX_CUSTOMER_OFFSET,
  MAX_CUSTOMER_PAGE_SIZE,
  type SearchCustomersCommand,
  SearchCustomersInput,
  searchCustomers,
} from "./queries";
export {
  CUSTOMER_FIELD_LIMITS,
  escapeLike,
  MIN_PHONE_CONTAINS,
  MIN_PHONE_PREFIX,
  NAME_SIMILARITY_THRESHOLD,
  normalizePhone,
  SEARCH_MATCH_KINDS,
  SEARCH_TIERS,
  type SearchMatchKind,
  type SearchTerms,
  searchTerms,
} from "./rules";
export type {
  CreateCustomerResult,
  CustomerAreaOption,
  CustomerConnectionSummary,
  CustomerFormOptions,
  CustomerLastPayment,
  CustomerListRow,
  CustomerProfile,
  CustomerSearchResult,
  CustomerView,
  UpdateCustomerResult,
} from "./types";
