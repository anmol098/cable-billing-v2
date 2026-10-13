package com.cablebilling.detekt

import io.gitlab.arturbosch.detekt.api.CodeSmell
import io.gitlab.arturbosch.detekt.api.Config
import io.gitlab.arturbosch.detekt.api.Debt
import io.gitlab.arturbosch.detekt.api.Entity
import io.gitlab.arturbosch.detekt.api.Issue
import io.gitlab.arturbosch.detekt.api.Rule
import io.gitlab.arturbosch.detekt.api.Severity
import org.jetbrains.kotlin.psi.KtCallExpression
import org.jetbrains.kotlin.psi.KtConstantExpression
import org.jetbrains.kotlin.psi.KtDotQualifiedExpression
import org.jetbrains.kotlin.psi.KtExpression
import org.jetbrains.kotlin.psi.KtNameReferenceExpression
import org.jetbrains.kotlin.psi.KtPrefixExpression
import org.jetbrains.kotlin.psi.KtPsiUtil

/**
 * Flags `Color(0x…)` (and any `Color(…)` built from number literals) outside core/designsystem.
 * Colours come from the generated `Tokens.Color` / `LocalSemanticColors` (CLAUDE.md "Design tokens only").
 */
class RawColorLiteral(
    config: Config = Config.empty,
) : Rule(config) {
    override val issue =
        Issue(
            id = "RawColorLiteral",
            severity = Severity.Style,
            description =
                "Raw colour literal. Use Tokens.Color or CableTheme.semanticColors " +
                    "(packages/design-tokens/tokens.json) instead.",
            debt = Debt.FIVE_MINS,
        )

    override fun visitCallExpression(expression: KtCallExpression) {
        super.visitCallExpression(expression)
        val callee = (expression.calleeExpression as? KtNameReferenceExpression)?.getReferencedName()
        // `Color(…)`, or an import alias such as `ComposeColor(…)`.
        val isColorCall = callee == "Color" || (callee?.endsWith("Color") == true && callee.first().isUpperCase())
        if (!isColorCall) return
        val args = expression.valueArguments.mapNotNull { it.getArgumentExpression() }
        val hasHexArgument = args.any { it.text.startsWith("0x", ignoreCase = true) }
        if (hasHexArgument || (args.isNotEmpty() && args.all { it.isNumberLiteral() })) {
            report(CodeSmell(issue, Entity.from(expression), "Raw colour `${expression.text}`. ${issue.description}"))
        }
    }
}

/**
 * Flags number literals turned into dimensions (`16.dp`, `4.5.dp`, `18.sp`, `(-2).dp`) outside
 * core/designsystem. Sizes come from `Tokens.Space`, `Tokens.Size`, `Tokens.Radius`, `Tokens.Type` …
 */
class RawDimensionLiteral(
    config: Config = Config.empty,
) : Rule(config) {
    override val issue =
        Issue(
            id = "RawDimensionLiteral",
            severity = Severity.Style,
            description =
                "Raw dimension literal. Use Tokens.Space / Size / Radius / Border / Type " +
                    "(packages/design-tokens/tokens.json) instead.",
            debt = Debt.FIVE_MINS,
        )

    override fun visitDotQualifiedExpression(expression: KtDotQualifiedExpression) {
        super.visitDotQualifiedExpression(expression)
        val selector = (expression.selectorExpression as? KtNameReferenceExpression)?.getReferencedName()
        if (selector !in DIMENSION_UNITS) return
        if (expression.receiverExpression.isNumberLiteral()) {
            report(
                CodeSmell(issue, Entity.from(expression), "Raw dimension `${expression.text}`. ${issue.description}"),
            )
        }
    }

    private companion object {
        val DIMENSION_UNITS = setOf("dp", "sp", "em")
    }
}

private fun KtExpression.isNumberLiteral(): Boolean =
    when (val unwrapped = KtPsiUtil.safeDeparenthesize(this)) {
        is KtConstantExpression -> unwrapped.text.firstOrNull()?.isDigit() == true
        is KtPrefixExpression -> unwrapped.baseExpression?.isNumberLiteral() == true
        else -> false
    }
