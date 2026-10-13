package com.cablebilling.detekt

import io.gitlab.arturbosch.detekt.test.lint
import org.junit.Assert.assertEquals
import org.junit.Test

class RawDesignValueRulesTest {
    @Test
    fun `flags raw colour literals`() {
        val code =
            """
            val a = Color(0xFF15803D)
            val b = ComposeColor(0xFF111111)
            val c = Color(255, 0, 0)
            val d = Color(0xFF111111.toInt())
            """.trimIndent()
        assertEquals(4, RawColorLiteral().lint(code).size)
    }

    @Test
    fun `allows token colours`() {
        val code =
            """
            val a = Tokens.Color.Cash
            val b = Color(red = r, green = g, blue = b)
            val c = Color.Transparent
            """.trimIndent()
        assertEquals(0, RawColorLiteral().lint(code).size)
    }

    @Test
    fun `flags raw dimension literals`() {
        val code =
            """
            val a = 16.dp
            val b = 4.5.dp
            val c = 18.sp
            val d = (-2).dp
            val e = 0.dp
            """.trimIndent()
        assertEquals(5, RawDimensionLiteral().lint(code).size)
    }

    @Test
    fun `allows token dimensions`() {
        val code =
            """
            val a = Tokens.Space.Base * 4
            val b = Tokens.Size.TouchMin
            val c = someValue.dp
            """.trimIndent()
        assertEquals(0, RawDimensionLiteral().lint(code).size)
    }
}
