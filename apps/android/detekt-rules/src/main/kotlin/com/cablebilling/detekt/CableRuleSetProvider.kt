package com.cablebilling.detekt

import io.gitlab.arturbosch.detekt.api.Config
import io.gitlab.arturbosch.detekt.api.RuleSet
import io.gitlab.arturbosch.detekt.api.RuleSetProvider

/** The `cable` rule set (configured in config/detekt/detekt.yml). */
class CableRuleSetProvider : RuleSetProvider {
    override val ruleSetId: String = "cable"

    override fun instance(config: Config): RuleSet =
        RuleSet(
            ruleSetId,
            listOf(
                RawColorLiteral(config),
                RawDimensionLiteral(config),
            ),
        )
}
