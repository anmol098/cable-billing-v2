package com.cablebilling.lineman.data.network

import com.cablebilling.lineman.data.network.generated.AppConfigResponse
import com.cablebilling.lineman.data.network.generated.CollectionDayResponse
import com.cablebilling.lineman.data.network.generated.CustomerDetailResponse
import com.cablebilling.lineman.data.network.generated.HandoverRequest
import com.cablebilling.lineman.data.network.generated.HandoverResponse
import com.cablebilling.lineman.data.network.generated.PaymentBatchRequest
import com.cablebilling.lineman.data.network.generated.PaymentBatchResponse
import com.cablebilling.lineman.data.network.generated.ReceiptActionsRequest
import com.cablebilling.lineman.data.network.generated.ReceiptActionsResponse
import com.cablebilling.lineman.data.network.generated.ReceiptLinkResponse
import com.cablebilling.lineman.data.network.generated.SyncCustomersResponse
import com.cablebilling.lineman.data.network.generated.UpdatePhoneRequest
import com.cablebilling.lineman.data.network.generated.UpdatePhoneResponse
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.PATCH
import retrofit2.http.POST
import retrofit2.http.Path
import retrofit2.http.Query

/**
 * Every bearer-authenticated endpoint of `/api/mobile/v1` (PLAN §10.2, packages/contracts
 * `ENDPOINTS`). Inject it as is: it runs on the authenticated client, which adds
 * `x-app-version-code` and `Authorization: Bearer …`, refreshes the session on UNAUTHENTICATED and
 * retries once. Wrap every call in [apiCall] to get an [ApiResult].
 *
 * Paths are relative to `BuildConfig.API_BASE_URL` (no leading slash). Ids, dates (`YYYY-MM-DD`,
 * India time) and instants are `String`s as on the wire; money is `Long` paise.
 */
interface MobileApi {
    /** `GET /app/config`: force-update gate, operator, tenant mode, feature flags. Never APP_TOO_OLD. */
    @GET("app/config")
    suspend fun getAppConfig(): AppConfigResponse

    /** `GET /sync/customers` roster delta (T-064). No cursor = full sync. Errors: CURSOR_INVALID. */
    @GET("sync/customers")
    suspend fun syncCustomers(
        @Query("cursor") cursor: String? = null,
        @Query("limit") limit: Int? = null,
    ): SyncCustomersResponse

    /** `GET /customers/{id}`: fresh detail when online (T-065). Errors: CUSTOMER_NOT_FOUND. */
    @GET("customers/{id}")
    suspend fun getCustomer(
        @Path("id") customerId: String,
    ): CustomerDetailResponse

    /** `PATCH /customers/{id}/phone` (T-069). Errors: CUSTOMER_NOT_FOUND, TENANT_READ_ONLY. */
    @PATCH("customers/{id}/phone")
    suspend fun updateCustomerPhone(
        @Path("id") customerId: String,
        @Body body: UpdatePhoneRequest,
    ): UpdatePhoneResponse

    /**
     * `POST /payments:batch` (T-066): 1–50 queued payments, results in request order. The `./`
     * prefix is required: a bare `payments:batch` would parse as a URL with the scheme `payments`.
     */
    @POST("./payments:batch")
    suspend fun postPaymentBatch(
        @Body body: PaymentBatchRequest,
    ): PaymentBatchResponse

    /** `GET /collections/{date}`: the server's totals for the lineman's day (T-070). */
    @GET("collections/{date}")
    suspend fun getCollectionDay(
        @Path("date") businessDate: String,
    ): CollectionDayResponse

    /**
     * `POST /collections/{date}/handover` (T-070). Errors: HANDOVER_ALREADY_ACCEPTED,
     * ID_REUSED_WITH_DIFFERENT_DATA.
     */
    @POST("collections/{date}/handover")
    suspend fun submitHandover(
        @Path("date") businessDate: String,
        @Body body: HandoverRequest,
    ): HandoverResponse

    /** `POST /receipts/{paymentId}/link` (T-069, online only). Errors: PAYMENT_NOT_FOUND (not synced yet). */
    @POST("receipts/{paymentId}/link")
    suspend fun createReceiptLink(
        @Path("paymentId") paymentId: String,
    ): ReceiptLinkResponse

    /** `POST /receipts/actions:batch` (T-069): 1–100 honest receipt actions. */
    @POST("receipts/actions:batch")
    suspend fun postReceiptActions(
        @Body body: ReceiptActionsRequest,
    ): ReceiptActionsResponse
}
