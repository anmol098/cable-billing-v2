package com.cablebilling.lineman

import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Flavour config that Retrofit depends on (runs for whichever variant is tested, e.g. devDebug). */
class BuildConfigTest {
    @Test
    fun `API base URL is the mobile v1 API and ends with a slash for Retrofit`() {
        val url = BuildConfig.API_BASE_URL.toHttpUrl()
        assertTrue(BuildConfig.API_BASE_URL, BuildConfig.API_BASE_URL.endsWith("/api/mobile/v1/"))
        if (BuildConfig.FLAVOR != "dev") {
            assertEquals("staging and prod must use HTTPS", "https", url.scheme)
        }
    }
}
