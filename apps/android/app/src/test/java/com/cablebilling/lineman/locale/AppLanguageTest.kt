package com.cablebilling.lineman.locale

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AppLanguageTest {
    @Test
    fun `defaults to Hindi when no app language is set`() {
        assertEquals("hi", AppLanguage.defaultToApply(""))
        assertEquals("hi", AppLanguage.defaultToApply(" "))
    }

    @Test
    fun `keeps a language the user picked`() {
        assertNull(AppLanguage.defaultToApply("en"))
        assertNull(AppLanguage.defaultToApply("hi"))
        assertNull(AppLanguage.defaultToApply("en-IN,hi"))
    }

    @Test
    fun `Hindi is the default and both shipped languages are supported`() {
        assertEquals("hi", AppLanguage.DEFAULT)
        assertEquals(listOf("hi", "en"), AppLanguage.SUPPORTED)
    }
}
