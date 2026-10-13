/**
 * Operator settings (T-030): the business profile services and their input rules, and the
 * settings access check shared with the areas services.
 */
export { type SettingsAccess, type SettingsReadOnlyReason, settingsAccess } from "./access";
export {
  BUSINESS_PROFILE_LIMITS,
  type BusinessProfile,
  type BusinessProfileField,
  type BusinessProfileView,
  getBusinessProfile,
  INVOICE_PREFIX_PATTERN,
  normalizeInvoicePrefix,
  normalizeOfficePhone,
  OFFICE_PHONE_PATTERN,
  type UpdateBusinessProfileCommand,
  UpdateBusinessProfileInput,
  type UpdateBusinessProfileResult,
  updateBusinessProfile,
} from "./profile";
export { hasNoControlCharacters, multiLine, oneLine } from "./text";
