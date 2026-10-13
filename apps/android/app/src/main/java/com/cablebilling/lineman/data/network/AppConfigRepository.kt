package com.cablebilling.lineman.data.network

import com.cablebilling.lineman.data.auth.SessionStore
import com.cablebilling.lineman.data.network.generated.AppConfigResponse
import com.cablebilling.lineman.data.network.generated.TenantMode
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import javax.inject.Inject
import javax.inject.Singleton

/**
 * `GET /app/config` (PLAN §11.9): read on start (SessionGate) and after every sync (T-064 calls
 * [refresh]). Each answer updates the force-update gate, the operator details in the session
 * (office phone, receipt footer) and [config].
 *
 * Read-only tenants (D-13) keep collecting and syncing; the app shows no banner for it.
 */
@Singleton
class AppConfigRepository
    @Inject
    constructor(
        private val api: MobileApi,
        private val gate: UpdateGate,
        private val store: SessionStore,
        private val errors: ApiErrorParser,
    ) {
        private val mutableConfig = MutableStateFlow<AppConfigResponse?>(null)

        /** The last config heard in this run, or null. */
        val config: StateFlow<AppConfigResponse?> = mutableConfig.asStateFlow()

        suspend fun refresh(): ApiResult<AppConfigResponse> {
            val result = apiCall(errors) { api.getAppConfig() }
            if (result is ApiResult.Success) {
                val config = result.value
                gate.onMinimumFromConfig(config.minAppVersionCode)
                store.updateOperator(config.operator)
                mutableConfig.value = config
            }
            return result
        }

        /** A feature flag from the last config; a missing or unknown flag is off. */
        fun isFeatureOn(name: String): Boolean = config.value?.features?.get(name) == true

        /** The tenant mode from the last config (normal until heard otherwise). */
        val tenantMode: TenantMode get() = config.value?.tenantMode ?: TenantMode.NORMAL
    }
