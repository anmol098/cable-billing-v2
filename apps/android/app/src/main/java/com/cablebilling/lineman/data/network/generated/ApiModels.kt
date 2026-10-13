// GENERATED from packages/contracts/openapi.json ("Cable Billing mobile API" 1.0.0).
// Do not edit. Generator: app/src/test/.../data/network/codegen/ApiModelGenerator.kt. Regenerate:
// ./gradlew :app:testDevDebugUnitTest --tests '*ApiModelsUpToDateTest' -Pcb.writeApiModels=true

package com.cablebilling.lineman.data.network.generated

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/** The contract these models were generated from. */
object ApiContract {
    /** `info.version` of openapi.json (packages/contracts `CONTRACT_VERSION`). */
    const val VERSION: String = "1.0.0"
}

/** Part of a payment applied to one bill (oldest bill first, PRD §13.2). */
@Serializable
data class Allocation(
    /** The bill this money went to. */
    @SerialName("invoice_id") val invoiceId: String,
    /** Bill number. */
    @SerialName("invoice_number") val invoiceNumber: String,
    /** Monthly bill or old dues. */
    @SerialName("kind") val kind: BillKind,
    /** Month of that bill (YYYY-MM-01). */
    @SerialName("period") val period: String,
    /** How much of this payment went to that bill, in paise. */
    @SerialName("amount_paise") val amountPaise: Long,
    /** What was left to pay on that bill right after this payment (0 = fully paid). For the receipt line 'Oct bill paid, Nov bill ₹50 left'. */
    @SerialName("outstanding_after_paise") val outstandingAfterPaise: Long,
)

/** Why the request failed. */
@Serializable
data class ApiError(
    /** Stable machine code; see ErrorCode. */
    @SerialName("code") val code: String,
    /** Developer-facing English detail for logs. Never shown to users; never contains PII. */
    @SerialName("message") val message: String,
    /** Server request id. Shown in diagnostics so support can find the server logs. */
    @SerialName("request_id") val requestId: String,
    /** Only for VALIDATION: the invalid fields. Absent for other codes. */
    @SerialName("fields") val fields: List<FieldIssue>? = null,
    /** Only for APP_TOO_OLD: the lowest Android versionCode the server accepts. Absent otherwise. */
    @SerialName("min_app_version_code") val minAppVersionCode: Long? = null,
    /** Only for RATE_LIMITED: seconds to wait before retrying. Absent otherwise. */
    @SerialName("retry_after_seconds") val retryAfterSeconds: Long? = null,
)

/** Settings the app reads on start and after every sync. */
@Serializable
data class AppConfigResponse(
    /** Server clock when the response was made (UTC). The phone uses it to spot a wrong device clock and to label 'Updated X min ago'. */
    @SerialName("server_time") val serverTime: String,
    /** The lowest Android versionCode the server accepts. If the installed app is older, show only the full-screen 'Update app' button; queued payments stay on the phone and sync after the update. */
    @SerialName("min_app_version_code") val minAppVersionCode: Long,
    /** The lineman's operator (name, office phone, receipt footer). */
    @SerialName("operator") val operator: OperatorInfo,
    /** Whether the operator is in normal or read-only mode. */
    @SerialName("tenant_mode") val tenantMode: TenantMode,
    /** Feature flags by name (snake_case). A missing flag means off; unknown flags must be ignored. New flags may appear at any time within v1. */
    @SerialName("features") val features: Map<String, Boolean>,
)

/** The area (locality) a customer belongs to. */
@Serializable
data class AreaRef(
    /** Area id. */
    @SerialName("id") val id: String,
    /** Area name as the operator typed it. */
    @SerialName("name") val name: String,
)

/** 'regular' for a monthly bill, 'opening_balance' for old dues brought in when the operator started using Cable Billing. */
@Serializable
enum class BillKind(val wire: String) {
    @SerialName("regular") REGULAR("regular"),
    @SerialName("opening_balance") OPENING_BALANCE("opening_balance"),
    ;

    companion object {
        /** The value whose wire name is [wire], or null if this app does not know it. */
        fun fromWire(wire: String): BillKind? = entries.firstOrNull { it.wire == wire }
    }
}

/** The lineman's collection session for one business date (PLAN §8.7). All zero with status 'open' if nothing was collected. */
@Serializable
data class CollectionDay(
    /** The India-time day (YYYY-MM-DD). */
    @SerialName("business_date") val businessDate: String,
    /** Cash collected (server-known, not reversed), in paise: the cash the office expects. */
    @SerialName("cash_total_paise") val cashTotalPaise: Long,
    /** UPI collected (server-known, not reversed), in paise. Not part of the cash handover. */
    @SerialName("upi_total_paise") val upiTotalPaise: Long,
    /** Number of server-known payments, not reversed. */
    @SerialName("payment_count") val paymentCount: Long,
    /** Where the cash handover stands. */
    @SerialName("status") val status: HandoverStatus,
    /** The latest handover, or null while status is open. */
    @SerialName("handover") val handover: Handover? = null,
    /** The day's server-known payments by this lineman, newest first (including reversed ones, flagged). */
    @SerialName("payments") val payments: List<DayPayment>,
)

/** The lineman's own totals for the day (the Today screen). */
@Serializable
data class CollectionDayResponse(
    /** Server clock when the response was made (UTC). The phone uses it to spot a wrong device clock and to label 'Updated X min ago'. */
    @SerialName("server_time") val serverTime: String,
    /** The day's totals, payments and handover. */
    @SerialName("session") val session: CollectionDay,
)

/** One current connection (VC assignment) of the customer. */
@Serializable
data class Connection(
    /** VC (viewing card) number as stored, searched by the number pad. Match on digits; never parse it. */
    @SerialName("vc_number") val vcNumber: String,
    /** Whether the connection is on or suspended. */
    @SerialName("status") val status: ConnectionStatus,
)

/** 'active' or 'suspended' (temporarily off). Disconnected connections are not sent to the phone. */
@Serializable
enum class ConnectionStatus(val wire: String) {
    @SerialName("active") ACTIVE("active"),
    @SerialName("suspended") SUSPENDED("suspended"),
    ;

    companion object {
        /** The value whose wire name is [wire], or null if this app does not know it. */
        fun fromWire(wire: String): ConnectionStatus? = entries.firstOrNull { it.wire == wire }
    }
}

/** Fresh customer detail for the customer screen when online. Upsert `customer` into the roster cache. */
@Serializable
data class CustomerDetailResponse(
    /** Server clock when the response was made (UTC). The phone uses it to spot a wrong device clock and to label 'Updated X min ago'. */
    @SerialName("server_time") val serverTime: String,
    /** The customer, same shape as a roster row. */
    @SerialName("customer") val customer: RosterCustomer,
    /** Unpaid bills, oldest first (the order payments are applied, PRD §13.2). */
    @SerialName("open_bills") val openBills: List<OpenBill>,
    /** The latest payments, newest first (at most 20; the server usually sends 10). */
    @SerialName("recent_payments") val recentPayments: List<RecentPayment>,
)

/** A payment the server has for this lineman and day. */
@Serializable
data class DayPayment(
    /** Payment id. */
    @SerialName("payment_id") val paymentId: String,
    /** Customer id. */
    @SerialName("customer_id") val customerId: String,
    /** Customer code. */
    @SerialName("customer_code") val customerCode: String,
    /** Customer name. */
    @SerialName("customer_name") val customerName: String,
    /** Amount, in paise. */
    @SerialName("amount_paise") val amountPaise: Long,
    /** Cash or UPI. */
    @SerialName("method") val method: PaymentMethod,
    /** When it was taken, by the phone's clock (UTC). */
    @SerialName("recorded_at") val recordedAt: String,
    /** When the server accepted it (UTC). */
    @SerialName("posted_at") val postedAt: String,
    /** Permanent receipt number. */
    @SerialName("receipt_number") val receiptNumber: String,
    /** The phone's provisional reference, or null for a payment not taken on a phone. */
    @SerialName("provisional_ref") val provisionalRef: String? = null,
    /** True if the owner reversed it; reversed payments are not in the totals. */
    @SerialName("reversed") val reversed: Boolean,
)

/** The phone signing in (registered in `devices`). */
@Serializable
data class DeviceInfo(
    /** Random UUID the app makes once per installation and keeps until it is uninstalled. Identifies this phone's install to the server. */
    @SerialName("install_id") val installId: String,
    /** Phone maker and model (Build.MANUFACTURER + Build.MODEL), e.g. 'Xiaomi Redmi 9A'. */
    @SerialName("model") val model: String,
    /** Android version, e.g. 'Android 13 (API 33)'. */
    @SerialName("os") val os: String,
    /** App version name for display and support, e.g. '1.0.3'. Not compared. */
    @SerialName("app_version") val appVersion: String,
    /** Android versionCode of the installed app (an integer that grows with every release). The force-update gate compares this, never the version name. */
    @SerialName("app_version_code") val appVersionCode: Long,
)

/**
 * Why the cash handed over differs from the expected cash (picked from icon tiles, PLAN §11.3):
 * - short: less cash than expected.
 * - extra: more cash than expected.
 * - pending_sync: some payments are still on the phone, so the server total is behind.
 * - other: anything else (explain in the note).
 */
@Serializable
enum class DiscrepancyReason(val wire: String) {
    @SerialName("short") SHORT("short"),
    @SerialName("extra") EXTRA("extra"),
    @SerialName("pending_sync") PENDING_SYNC("pending_sync"),
    @SerialName("other") OTHER("other"),
    ;

    companion object {
        /** The value whose wire name is [wire], or null if this app does not know it. */
        fun fromWire(wire: String): DiscrepancyReason? = entries.firstOrNull { it.wire == wire }
    }
}

/**
 * Stable machine error code. The app maps it to Hindi/English text and an icon; it never shows `message`.
 * New codes may be added within v1: map an unknown code by the HTTP status.
 *
 * - VALIDATION (400): The request is malformed or a value is out of range. `fields` says which.
 * - NOT_FOUND (404): No such route or entity in this tenant.
 * - FORBIDDEN (403): This user's role may not do this (PLAN §9.3).
 * - UNAUTHENTICATED (401): The access token is missing, expired or invalid. Call /auth/refresh once, then retry the request.
 * - CONFLICT (409): The data changed underneath the request.
 * - TENANT_READ_ONLY (403): The operator's subscription is read-only (D-13). Collections still work (payments, handovers, receipt links and receipt actions); in the mobile API only the phone-number update can get this.
 * - ID_REUSED_WITH_DIFFERENT_DATA (409): An idempotency key (payment id, action id, submission id) was already used with a different payload (PLAN §8.4). Never retry it; call the office.
 * - INVARIANT_VIOLATION (500): A financial invariant would break. Always a server bug; nothing was saved.
 * - APP_TOO_OLD (426): The app is older than min_app_version_code. Show the full-screen 'Update app' screen; queued payments stay on the phone.
 * - INVALID_CREDENTIALS (401): Wrong login or password.
 * - ACCOUNT_DISABLED (403): The user (or the operator) is deactivated. Call the office.
 * - ROLE_NOT_ALLOWED (403): Only linemen sign in on the Android app; owners and staff use the web.
 * - REFRESH_TOKEN_INVALID (401): The refresh token is unknown, expired or was already used. Sign in again (queued payments are kept).
 * - DEVICE_REVOKED (401): The owner signed this phone out. Sign in again (queued payments are kept and flagged if another user signs in).
 * - RATE_LIMITED (429): Too many requests. Wait `retry_after_seconds` (also sent as Retry-After).
 * - CURSOR_INVALID (400): The sync cursor is unknown or too old. Drop it and start a full sync (no cursor).
 * - CUSTOMER_NOT_FOUND (404): No such customer in this operator (cross-tenant ids also get this).
 * - PAYMENT_NOT_FOUND (404): The server has no such payment in this operator, usually because it has not synced yet. Keep the request and retry after the payment syncs.
 * - HANDOVER_ALREADY_ACCEPTED (409): The office already accepted this day's handover; it can no longer change.
 * - INTERNAL (500): Unexpected server error. Nothing was saved by the failed part; retry later.
 *
 * Open enum: the server may add values within v1, so properties carrying it are `String`. Look a value up with [fromWire] (null = a code this app does not know; map it by HTTP status).
 */
@Serializable
enum class ErrorCode(val wire: String) {
    @SerialName("VALIDATION") VALIDATION("VALIDATION"),
    @SerialName("NOT_FOUND") NOT_FOUND("NOT_FOUND"),
    @SerialName("FORBIDDEN") FORBIDDEN("FORBIDDEN"),
    @SerialName("UNAUTHENTICATED") UNAUTHENTICATED("UNAUTHENTICATED"),
    @SerialName("CONFLICT") CONFLICT("CONFLICT"),
    @SerialName("TENANT_READ_ONLY") TENANT_READ_ONLY("TENANT_READ_ONLY"),
    @SerialName("ID_REUSED_WITH_DIFFERENT_DATA") ID_REUSED_WITH_DIFFERENT_DATA("ID_REUSED_WITH_DIFFERENT_DATA"),
    @SerialName("INVARIANT_VIOLATION") INVARIANT_VIOLATION("INVARIANT_VIOLATION"),
    @SerialName("APP_TOO_OLD") APP_TOO_OLD("APP_TOO_OLD"),
    @SerialName("INVALID_CREDENTIALS") INVALID_CREDENTIALS("INVALID_CREDENTIALS"),
    @SerialName("ACCOUNT_DISABLED") ACCOUNT_DISABLED("ACCOUNT_DISABLED"),
    @SerialName("ROLE_NOT_ALLOWED") ROLE_NOT_ALLOWED("ROLE_NOT_ALLOWED"),
    @SerialName("REFRESH_TOKEN_INVALID") REFRESH_TOKEN_INVALID("REFRESH_TOKEN_INVALID"),
    @SerialName("DEVICE_REVOKED") DEVICE_REVOKED("DEVICE_REVOKED"),
    @SerialName("RATE_LIMITED") RATE_LIMITED("RATE_LIMITED"),
    @SerialName("CURSOR_INVALID") CURSOR_INVALID("CURSOR_INVALID"),
    @SerialName("CUSTOMER_NOT_FOUND") CUSTOMER_NOT_FOUND("CUSTOMER_NOT_FOUND"),
    @SerialName("PAYMENT_NOT_FOUND") PAYMENT_NOT_FOUND("PAYMENT_NOT_FOUND"),
    @SerialName("HANDOVER_ALREADY_ACCEPTED") HANDOVER_ALREADY_ACCEPTED("HANDOVER_ALREADY_ACCEPTED"),
    @SerialName("INTERNAL") INTERNAL("INTERNAL"),
    ;

    companion object {
        /** The value whose wire name is [wire], or null if this app does not know it. */
        fun fromWire(wire: String): ErrorCode? = entries.firstOrNull { it.wire == wire }
    }
}

/** Body of every error response (4xx/5xx). The HTTP status follows the code (see ErrorCode). */
@Serializable
data class ErrorResponse(
    /** Server clock when the response was made (UTC). */
    @SerialName("server_time") val serverTime: String,
    /** The error: stable code plus details for logs. */
    @SerialName("error") val error: ApiError,
)

/** One invalid field in a VALIDATION error. */
@Serializable
data class FieldIssue(
    /** Where the problem is, as a dot path into the request body or parameters, e.g. 'payments.3.amount_paise' or 'query.limit'. */
    @SerialName("path") val path: String,
    /** Machine reason, e.g. 'too_small', 'invalid_format', 'required'. For logs and tests, not shown to users. */
    @SerialName("issue") val issue: String,
)

/** The latest cash handover for the day. */
@Serializable
data class Handover(
    /** The submission_id of the latest handover. */
    @SerialName("submission_id") val submissionId: String,
    /** Cash the server expected when the handover was submitted, in paise (server-side cash total; UPI excluded). */
    @SerialName("cash_expected_paise") val cashExpectedPaise: Long,
    /** Cash the lineman handed over, in paise. */
    @SerialName("cash_handed_over_paise") val cashHandedOverPaise: Long,
    /** cash_handed_over_paise − cash_expected_paise, computed by the server. Negative = short, positive = extra. */
    @SerialName("discrepancy_paise") val discrepancyPaise: Long,
    /** The lineman's reason when there is a discrepancy, else null. */
    @SerialName("discrepancy_reason") val discrepancyReason: DiscrepancyReason? = null,
    /** The lineman's note, or null. */
    @SerialName("note") val note: String? = null,
    /** Payments still on the phone when the handover was submitted (warning for office). */
    @SerialName("unsynced_payment_count") val unsyncedPaymentCount: Long,
    /** Cash of those unsynced payments, in paise, as the phone reported it. */
    @SerialName("unsynced_cash_paise") val unsyncedCashPaise: Long,
    /** When the server received the handover (UTC). */
    @SerialName("submitted_at") val submittedAt: String,
    /** When the office accepted or returned it (UTC), or null while submitted. */
    @SerialName("reviewed_at") val reviewedAt: String? = null,
    /** The office's note when it returned (or accepted) the handover, or null. */
    @SerialName("review_note") val reviewNote: String? = null,
)

/** Hand over the day's cash. Allowed while the day is open, submitted or returned; a new submission replaces the previous one. Once accepted: HANDOVER_ALREADY_ACCEPTED. */
@Serializable
data class HandoverRequest(
    /** Idempotency key for this submission (a new UUID per Submit tap; reuse it when retrying the same submission). */
    @SerialName("submission_id") val submissionId: String,
    /** Cash the lineman hands over, in paise (≥ 0). */
    @SerialName("cash_handed_over_paise") val cashHandedOverPaise: Long,
    /** Required when the cash differs from the server's expected cash (VALIDATION otherwise); omit or null when it matches. */
    @SerialName("discrepancy_reason") val discrepancyReason: DiscrepancyReason? = null,
    /** Optional note (e.g. for 'other'). Omit or null for none. */
    @SerialName("note") val note: String? = null,
    /** How many of this day's payments are still on the phone (0 when all synced). */
    @SerialName("unsynced_payment_count") val unsyncedPaymentCount: Long,
    /** Total cash of those unsynced payments, in paise (0 when all synced). */
    @SerialName("unsynced_cash_paise") val unsyncedCashPaise: Long,
)

/** The day after the handover (status 'submitted'). Repeating the same submission_id returns the current state. */
@Serializable
data class HandoverResponse(
    /** Server clock when the response was made (UTC). The phone uses it to spot a wrong device clock and to label 'Updated X min ago'. */
    @SerialName("server_time") val serverTime: String,
    /** The day's totals, payments and handover. */
    @SerialName("session") val session: CollectionDay,
)

/**
 * Where the day's cash handover stands:
 * - open: not handed over yet.
 * - submitted: the lineman handed over; the office has not checked it.
 * - accepted: the office accepted it (final).
 * - returned: the office sent it back with a note; the lineman can submit again.
 */
@Serializable
enum class HandoverStatus(val wire: String) {
    @SerialName("open") OPEN("open"),
    @SerialName("submitted") SUBMITTED("submitted"),
    @SerialName("accepted") ACCEPTED("accepted"),
    @SerialName("returned") RETURNED("returned"),
    ;

    companion object {
        /** The value whose wire name is [wire], or null if this app does not know it. */
        fun fromWire(wire: String): HandoverStatus? = entries.firstOrNull { it.wire == wire }
    }
}

/** Why one item of a batch was rejected. */
@Serializable
data class ItemError(
    /** Stable machine code; see ErrorCode. */
    @SerialName("code") val code: String,
    /** Developer-facing English detail for logs. Never shown to users; never contains PII. */
    @SerialName("message") val message: String,
    /** Only for VALIDATION: the invalid fields. Absent for other codes. */
    @SerialName("fields") val fields: List<FieldIssue>? = null,
)

/** Sign in a lineman on this phone. */
@Serializable
data class LoginRequest(
    /** The lineman's login (usually their mobile number). Compared case-insensitively after trimming. */
    @SerialName("login") val login: String,
    /** The password, exactly as typed. */
    @SerialName("password") val password: String,
    /** The phone signing in. */
    @SerialName("device") val device: DeviceInfo,
)

/** Signed in. Store the tokens encrypted; keep user, operator and device for offline use. */
@Serializable
data class LoginResponse(
    /** Server clock when the response was made (UTC). The phone uses it to spot a wrong device clock and to label 'Updated X min ago'. */
    @SerialName("server_time") val serverTime: String,
    /** The token pair for this phone. Store it encrypted. */
    @SerialName("tokens") val tokens: TokenPair,
    /** Who signed in (the collector printed on receipts). */
    @SerialName("user") val user: UserInfo,
    /** The lineman's operator. */
    @SerialName("operator") val operator: OperatorInfo,
    /** This phone's registration. */
    @SerialName("device") val device: RegisteredDevice,
)

/** Sign this phone out: revokes the refresh token's family. The app must not delete queued payments (PLAN §9.2). */
@Serializable
data class LogoutRequest(
    /** The refresh token to revoke. Works even when the access token has expired. */
    @SerialName("refresh_token") val refreshToken: String,
)

/** Signed out (also returned when the token was already revoked or unknown). */
@Serializable
data class LogoutResponse(
    /** Server clock when the response was made (UTC). The phone uses it to spot a wrong device clock and to label 'Updated X min ago'. */
    @SerialName("server_time") val serverTime: String,
)

/** A bill that still has money left to pay. */
@Serializable
data class OpenBill(
    /** Bill (invoice) id. */
    @SerialName("invoice_id") val invoiceId: String,
    /** Bill number. */
    @SerialName("invoice_number") val invoiceNumber: String,
    /** Monthly bill or old dues. */
    @SerialName("kind") val kind: BillKind,
    /** The month the bill is for (YYYY-MM-01). */
    @SerialName("period") val period: String,
    /** This bill's own charges in paise (rent and adjustments of the month; old dues for an opening_balance bill). Excludes earlier months' arrears. */
    @SerialName("charges_paise") val chargesPaise: Long,
    /** Money still to pay on this bill, in paise (always > 0 for an open bill). */
    @SerialName("outstanding_paise") val outstandingPaise: Long,
)

/** Summary of the customer's unpaid bills. */
@Serializable
data class OpenBillsSummary(
    /** Number of bills that still have money left to pay. */
    @SerialName("count") val count: Long,
    /** Money left to pay on those bills, in paise (the sum of their outstanding amounts). */
    @SerialName("outstanding_paise") val outstandingPaise: Long,
    /** Month of the oldest unpaid bill (YYYY-MM-01), or null when nothing is unpaid. */
    @SerialName("oldest_period") val oldestPeriod: String? = null,
)

/** The cable operator this lineman works for. */
@Serializable
data class OperatorInfo(
    /** Operator (tenant) id. */
    @SerialName("id") val id: String,
    /** Business name, shown in the app and on receipts. */
    @SerialName("name") val name: String,
    /** Office phone for the 'Call office' buttons, digits only (may include a leading +). Null if the operator has not set one. */
    @SerialName("office_phone") val officePhone: String? = null,
    /** Footer text the operator wants printed on receipts. Null for none. */
    @SerialName("receipt_footer") val receiptFooter: String? = null,
)

/** One payment saved on the phone (PRD §13.3). upi_reference must be absent for cash. */
@Serializable
data class PaymentBatchItem(
    /** Payment id = idempotency key. A UUIDv7 the phone creates before saving the payment locally (FR-015); it never changes, so a retry can never post twice. */
    @SerialName("id") val id: String,
    /** The customer who paid. */
    @SerialName("customer_id") val customerId: String,
    /** Amount received, in paise (> 0). The app takes whole rupees (D-17), so this is a multiple of 100 today. */
    @SerialName("amount_paise") val amountPaise: Long,
    /** Cash or UPI. */
    @SerialName("method") val method: PaymentMethod,
    /** UPI reference the lineman typed (optional, only with method 'upi'). Not proof of payment (BR-10). Omit or null when skipped. */
    @SerialName("upi_reference") val upiReference: String? = null,
    /** Optional note. Omit or null for none. */
    @SerialName("notes") val notes: String? = null,
    /** When the lineman saved the payment, by the phone's clock (UTC). More than 10 minutes in the future or more than 7 days old → posted_needs_review. */
    @SerialName("recorded_at") val recordedAt: String,
    /** The provisional receipt reference shown to the customer before sync (P-{device_code}-{seq}). Kept forever as an alias of the permanent receipt number (FR-016). */
    @SerialName("provisional_ref") val provisionalRef: String,
    /** Id of the user who took the payment (UserInfo.id when it was saved). The server takes identity from the token and flags a mismatch for review; it never trusts this for access. */
    @SerialName("collector_id") val collectorId: String,
    /** RegisteredDevice.id of this phone when the payment was saved. A mismatch with the token's device is flagged for review. */
    @SerialName("device_id") val deviceId: String,
)

/** Push queued payments. Safe to send again after a timeout or crash. */
@Serializable
data class PaymentBatchRequest(
    /** 1–50 queued payments, oldest first. The server posts them in this order. */
    @SerialName("payments") val payments: List<PaymentBatchItem>,
)

/** One result per request item, in the same order. Replaying a batch gives the same results (duplicates instead of posted). */
@Serializable
data class PaymentBatchResponse(
    /** Server clock when the response was made (UTC). The phone uses it to spot a wrong device clock and to label 'Updated X min ago'. */
    @SerialName("server_time") val serverTime: String,
    /** Results in request order, one per item, matched by id. */
    @SerialName("results") val results: List<PaymentBatchResult>,
)

/** The result for one payment. Exactly one of `payment` (saved) or `error` (not saved) is set. */
@Serializable
data class PaymentBatchResult(
    /** The payment id this result is for. */
    @SerialName("id") val id: String,
    /** What happened to this payment. */
    @SerialName("outcome") val outcome: PaymentOutcome,
    /** The saved payment for posted, duplicate and posted_needs_review; null for rejected and retry_later. */
    @SerialName("payment") val payment: PostedPayment? = null,
    /** Why the office must check it; set only for posted_needs_review, else null. */
    @SerialName("review_reason") val reviewReason: ReviewReason? = null,
    /** Why it failed; set only for rejected and retry_later, else null. */
    @SerialName("error") val error: ItemError? = null,
)

/** How the customer paid: 'cash' or 'upi' (UPI is recorded by hand, not verified). */
@Serializable
enum class PaymentMethod(val wire: String) {
    @SerialName("cash") CASH("cash"),
    @SerialName("upi") UPI("upi"),
    ;

    companion object {
        /** The value whose wire name is [wire], or null if this app does not know it. */
        fun fromWire(wire: String): PaymentMethod? = entries.firstOrNull { it.wire == wire }
    }
}

/**
 * What happened to one payment:
 * - posted: saved now; `payment` has the permanent receipt.
 * - duplicate: this id was already saved with the same data; `payment` is the original result.
 * - posted_needs_review: saved, but the office must check it (see review_reason). The money is safe.
 * - rejected: not saved and will never be (see error); show 'Call office'. Includes ID_REUSED_WITH_DIFFERENT_DATA.
 * - retry_later: a temporary server problem for this item; nothing saved. Keep it and send it again later.
 */
@Serializable
enum class PaymentOutcome(val wire: String) {
    @SerialName("posted") POSTED("posted"),
    @SerialName("duplicate") DUPLICATE("duplicate"),
    @SerialName("posted_needs_review") POSTED_NEEDS_REVIEW("posted_needs_review"),
    @SerialName("rejected") REJECTED("rejected"),
    @SerialName("retry_later") RETRY_LATER("retry_later"),
    ;

    companion object {
        /** The value whose wire name is [wire], or null if this app does not know it. */
        fun fromWire(wire: String): PaymentOutcome? = entries.firstOrNull { it.wire == wire }
    }
}

/** A payment the server has saved: what the final receipt prints (PLAN §11.8). */
@Serializable
data class PostedPayment(
    /** Payment id (the idempotency key). */
    @SerialName("id") val id: String,
    /** The customer who paid. */
    @SerialName("customer_id") val customerId: String,
    /** Amount, in paise. */
    @SerialName("amount_paise") val amountPaise: Long,
    /** Cash or UPI. */
    @SerialName("method") val method: PaymentMethod,
    /** The permanent receipt number. Replace the provisional reference with it everywhere (keep the link). */
    @SerialName("receipt_number") val receiptNumber: String,
    /** The provisional reference it replaces (FR-016). */
    @SerialName("provisional_ref") val provisionalRef: String,
    /** When it was taken, by the phone's clock (UTC), as sent. */
    @SerialName("recorded_at") val recordedAt: String,
    /** When the server accepted it (UTC). Show both times where they differ (PRD §13.3). */
    @SerialName("posted_at") val postedAt: String,
    /** The India-time day it counts for (from recorded_at): the collection session it belongs to. */
    @SerialName("business_date") val businessDate: String,
    /** Bills this payment paid, oldest first. Empty if it all went to advance. */
    @SerialName("allocations") val allocations: List<Allocation>,
    /** Part of this payment kept as advance (credit) because no bill was left to pay, in paise. */
    @SerialName("credit_added_paise") val creditAddedPaise: Long,
    /** The customer's balance right after this payment was posted, in paise (same meaning as RosterCustomer.balance_paise). A replay returns the same value. */
    @SerialName("balance_after_paise") val balanceAfterPaise: Long,
    /** The customer's advance right after this payment was posted, in paise. A replay returns the same value. */
    @SerialName("credit_after_paise") val creditAfterPaise: Long,
)

/** One receipt action from the phone's outbox. */
@Serializable
data class ReceiptActionItem(
    /** Idempotency key for this action, made on the phone when it happened. */
    @SerialName("id") val id: String,
    /** The payment whose receipt it was. */
    @SerialName("payment_id") val paymentId: String,
    /** What happened. */
    @SerialName("action") val action: ReceiptActionType,
    /** When it happened, by the phone's clock (UTC). */
    @SerialName("at") val at: String,
)

/**
 * What happened to one action:
 * - recorded: saved now.
 * - duplicate: already saved with the same data.
 * - rejected: invalid and never will be saved (see error); drop it from the outbox.
 * - retry_later: not saved yet (e.g. PAYMENT_NOT_FOUND because the payment has not synced); keep it and send again later.
 */
@Serializable
enum class ReceiptActionOutcome(val wire: String) {
    @SerialName("recorded") RECORDED("recorded"),
    @SerialName("duplicate") DUPLICATE("duplicate"),
    @SerialName("rejected") REJECTED("rejected"),
    @SerialName("retry_later") RETRY_LATER("retry_later"),
    ;

    companion object {
        /** The value whose wire name is [wire], or null if this app does not know it. */
        fun fromWire(wire: String): ReceiptActionOutcome? = entries.firstOrNull { it.wire == wire }
    }
}

/** The result for one receipt action. */
@Serializable
data class ReceiptActionResult(
    /** The action id this result is for. */
    @SerialName("id") val id: String,
    /** What happened to this action. */
    @SerialName("outcome") val outcome: ReceiptActionOutcome,
    /** Why it was not saved; set only for rejected and retry_later, else null. */
    @SerialName("error") val error: ItemError? = null,
)

/**
 * What the lineman did with a receipt. Observable states only: never 'sent' or 'delivered' (BR-12, RULE-19).
 * - printed: the printer accepted the receipt.
 * - print_failed: printing failed (printer off, no paper, not paired).
 * - whatsapp_opened: WhatsApp was opened with the message ready.
 * - sms_opened: the SMS app was opened with the message ready.
 * - pdf_shared: the receipt PDF was handed to the share sheet or WhatsApp.
 */
@Serializable
enum class ReceiptActionType(val wire: String) {
    @SerialName("printed") PRINTED("printed"),
    @SerialName("print_failed") PRINT_FAILED("print_failed"),
    @SerialName("whatsapp_opened") WHATSAPP_OPENED("whatsapp_opened"),
    @SerialName("sms_opened") SMS_OPENED("sms_opened"),
    @SerialName("pdf_shared") PDF_SHARED("pdf_shared"),
    ;

    companion object {
        /** The value whose wire name is [wire], or null if this app does not know it. */
        fun fromWire(wire: String): ReceiptActionType? = entries.firstOrNull { it.wire == wire }
    }
}

/** Push the receipt-action outbox. */
@Serializable
data class ReceiptActionsRequest(
    /** 1–100 actions, oldest first. Send them after their payments have synced. */
    @SerialName("actions") val actions: List<ReceiptActionItem>,
)

/** One result per request item, in the same order. */
@Serializable
data class ReceiptActionsResponse(
    /** Server clock when the response was made (UTC). The phone uses it to spot a wrong device clock and to label 'Updated X min ago'. */
    @SerialName("server_time") val serverTime: String,
    /** Results in request order, one per item, matched by id. */
    @SerialName("results") val results: List<ReceiptActionResult>,
)

/** A receipt preview link (FR-021). The page shows minimal personal data. */
@Serializable
data class ReceiptLink(
    /** The public preview page (https, unguessable token). Put it in the WhatsApp/SMS text as is. */
    @SerialName("url") val url: String,
    /** When the link stops working (90 days, D-14), UTC. */
    @SerialName("expires_at") val expiresAt: String,
    /** The receipt the link shows. */
    @SerialName("receipt_number") val receiptNumber: String,
)

/** A usable preview link for the payment's receipt: an existing unexpired one or a new one. Online only. */
@Serializable
data class ReceiptLinkResponse(
    /** Server clock when the response was made (UTC). The phone uses it to spot a wrong device clock and to label 'Updated X min ago'. */
    @SerialName("server_time") val serverTime: String,
    /** The preview link. */
    @SerialName("link") val link: ReceiptLink,
)

/** One of the customer's latest payments. */
@Serializable
data class RecentPayment(
    /** Payment id (the phone's idempotency key for phone payments). */
    @SerialName("payment_id") val paymentId: String,
    /** Amount paid, in paise. */
    @SerialName("amount_paise") val amountPaise: Long,
    /** Cash or UPI. */
    @SerialName("method") val method: PaymentMethod,
    /** When the payment was taken, by the collecting device's clock (UTC). */
    @SerialName("recorded_at") val recordedAt: String,
    /** When the server accepted it (UTC). */
    @SerialName("posted_at") val postedAt: String,
    /** Permanent receipt number. */
    @SerialName("receipt_number") val receiptNumber: String,
    /** The phone's provisional reference if the payment was taken on a phone, else null. */
    @SerialName("provisional_ref") val provisionalRef: String? = null,
    /** Name of the person who took the payment, or null if unknown (migrated data). */
    @SerialName("collected_by_name") val collectedByName: String? = null,
    /** True if the owner cancelled (reversed) this payment; its receipt is 'Cancelled'. */
    @SerialName("reversed") val reversed: Boolean,
)

/** Swap the refresh token for a new token pair. Reusing an old refresh token revokes the whole token family (REFRESH_TOKEN_INVALID). */
@Serializable
data class RefreshRequest(
    /** The current refresh token. */
    @SerialName("refresh_token") val refreshToken: String,
    /** This installation's install_id (must match the token's device). */
    @SerialName("install_id") val installId: String,
)

/** New tokens. The old refresh token no longer works. */
@Serializable
data class RefreshResponse(
    /** Server clock when the response was made (UTC). The phone uses it to spot a wrong device clock and to label 'Updated X min ago'. */
    @SerialName("server_time") val serverTime: String,
    /** The new tokens; replace both stored tokens. */
    @SerialName("tokens") val tokens: TokenPair,
)

/** This phone as the server registered it. */
@Serializable
data class RegisteredDevice(
    /** Server id of this device registration. Sent back on payments as device_id. */
    @SerialName("id") val id: String,
    /** Three-character code unique within the operator, used in provisional receipt references: P-{device_code}-{seq}. */
    @SerialName("device_code") val deviceCode: String,
)

/**
 * Why a posted payment needs an office check (the payment is kept, PRD §13.3):
 * - customer_inactive: the customer was deactivated before the payment synced.
 * - collector_inactive: the lineman was deactivated before it synced.
 * - collector_mismatch: saved by a different user than the one now signed in (PLAN §9.2).
 * - device_mismatch: saved on a different device registration than the token's.
 * - recorded_at_out_of_range: recorded_at is > 10 min in the future or > 7 days old (PLAN §10.4).
 * - other: any other reason the server flags.
 */
@Serializable
enum class ReviewReason(val wire: String) {
    @SerialName("customer_inactive") CUSTOMER_INACTIVE("customer_inactive"),
    @SerialName("collector_inactive") COLLECTOR_INACTIVE("collector_inactive"),
    @SerialName("collector_mismatch") COLLECTOR_MISMATCH("collector_mismatch"),
    @SerialName("device_mismatch") DEVICE_MISMATCH("device_mismatch"),
    @SerialName("recorded_at_out_of_range") RECORDED_AT_OUT_OF_RANGE("recorded_at_out_of_range"),
    @SerialName("other") OTHER("other"),
    ;

    companion object {
        /** The value whose wire name is [wire], or null if this app does not know it. */
        fun fromWire(wire: String): ReviewReason? = entries.firstOrNull { it.wire == wire }
    }
}

/** A customer as cached on the phone for search and the customer screen (PLAN §10.3). The roster and the customer detail use the same shape, so the app can upsert either. */
@Serializable
data class RosterCustomer(
    /** Customer id. */
    @SerialName("id") val id: String,
    /** Customer code, unique within the operator (searchable, e.g. '1045'). */
    @SerialName("code") val code: String,
    /** Customer name. */
    @SerialName("name") val name: String,
    /** Primary phone as stored (legacy data may not be a clean 10-digit number; confirm before using it, FR-004). Null when missing. */
    @SerialName("phone") val phone: String? = null,
    /** Second phone as stored, or null. */
    @SerialName("alt_phone") val altPhone: String? = null,
    /** Address as one line of text, or null. */
    @SerialName("address") val address: String? = null,
    /** The customer's area, or null when none is set. */
    @SerialName("area") val area: AreaRef? = null,
    /** False when the customer is deactivated. The roster never sends inactive customers (they come as removed_customer_ids); customer detail may. */
    @SerialName("active") val active: Boolean,
    /** Current connections (active or suspended), oldest first. May be empty. */
    @SerialName("connections") val connections: List<Connection>,
    /** The customer's ledger balance in paise. Positive: the customer owes this much in total. Zero or negative: nothing is due (negative means paid in advance). Show max(balance_paise, 0) as the due amount. */
    @SerialName("balance_paise") val balancePaise: Long,
    /** Advance (credit) in paise: money paid that is not yet used for any bill. Shown separately from the due (D-14). */
    @SerialName("credit_paise") val creditPaise: Long,
    /** Summary of unpaid bills. */
    @SerialName("open_bills") val openBills: OpenBillsSummary,
    /** When anything in this row last changed on the server (UTC). Part of the sync order. */
    @SerialName("updated_at") val updatedAt: String,
)

/** One page of roster changes, ordered by (updated_at, id). Send gzip-accepting requests: about 1,000 customers fit in under 1 MB gzipped. */
@Serializable
data class SyncCustomersResponse(
    /** Server clock when the response was made (UTC). The phone uses it to spot a wrong device clock and to label 'Updated X min ago'. */
    @SerialName("server_time") val serverTime: String,
    /** Active customers that are new or changed since the cursor. Upsert by id. */
    @SerialName("customers") val customers: List<RosterCustomer>,
    /** Tombstones: customers deactivated since the cursor. Delete them from the phone (queued payments for them are kept and still synced). */
    @SerialName("removed_customer_ids") val removedCustomerIds: List<String>,
    /** Where the next page or the next delta sync starts. Always present; store it after applying this page. */
    @SerialName("next_cursor") val nextCursor: String,
    /** True if more changes are waiting: request again at once with next_cursor. */
    @SerialName("has_more") val hasMore: Boolean,
)

/** 'normal', or 'read_only' when the operator's subscription lapsed (D-13). The app keeps collecting and syncing normally in read_only and shows no banner to linemen. */
@Serializable
enum class TenantMode(val wire: String) {
    @SerialName("normal") NORMAL("normal"),
    @SerialName("read_only") READ_ONLY("read_only"),
    ;

    companion object {
        /** The value whose wire name is [wire], or null if this app does not know it. */
        fun fromWire(wire: String): TenantMode? = entries.firstOrNull { it.wire == wire }
    }
}

/** Tokens for this phone. */
@Serializable
data class TokenPair(
    /** Always 'Bearer': send 'Authorization: Bearer <access_token>'. */
    @SerialName("token_type") val tokenType: String,
    /** Short-lived access token (about 15 minutes). Opaque; never parse it. */
    @SerialName("access_token") val accessToken: String,
    /** When the access token stops working (UTC). Refresh a little before this, or on UNAUTHENTICATED. */
    @SerialName("access_token_expires_at") val accessTokenExpiresAt: String,
    /** Refresh token for this device (180 days, sliding). Single use: every refresh returns a new one; store it encrypted and replace the old one atomically. */
    @SerialName("refresh_token") val refreshToken: String,
    /** When the refresh token expires if it is not used (UTC). Each refresh extends it. */
    @SerialName("refresh_token_expires_at") val refreshTokenExpiresAt: String,
)

/** Correct the customer's primary phone from the receipt flow (FR-004). Audited with source 'android'. Sending the current number again changes nothing. */
@Serializable
data class UpdatePhoneRequest(
    /** The confirmed or corrected primary mobile number. */
    @SerialName("phone") val phone: String,
)

/** The customer after the change. Upsert it into the roster cache. */
@Serializable
data class UpdatePhoneResponse(
    /** Server clock when the response was made (UTC). The phone uses it to spot a wrong device clock and to label 'Updated X min ago'. */
    @SerialName("server_time") val serverTime: String,
    /** True if the number changed; false if it already was this number. */
    @SerialName("changed") val changed: Boolean,
    /** The customer after the change. */
    @SerialName("customer") val customer: RosterCustomer,
)

/** The signed-in lineman. */
@Serializable
data class UserInfo(
    /** User id. */
    @SerialName("id") val id: String,
    /** Display name, printed on receipts as the collector. */
    @SerialName("name") val name: String,
    /** Login (lower-cased). */
    @SerialName("login") val login: String,
    /** The user's preferred UI language. */
    @SerialName("language") val language: UserInfoLanguage,
)

/** The user's preferred UI language. */
@Serializable
enum class UserInfoLanguage(val wire: String) {
    @SerialName("hi") HI("hi"),
    @SerialName("en") EN("en"),
    ;

    companion object {
        /** The value whose wire name is [wire], or null if this app does not know it. */
        fun fromWire(wire: String): UserInfoLanguage? = entries.firstOrNull { it.wire == wire }
    }
}
