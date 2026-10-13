package com.cablebilling.lineman.feature.search

/** Test tags of the search home. */
object SearchTags {
    const val SCREEN = "screen_search"
    const val BANNER = "search_banner"
    const val QUERY = "search_query"
    const val TEXT_FIELD = "search_text_field"
    const val NUMBERS_KEY = "search_numbers_key"
    const val HINT = "search_hint"
    const val NO_RESULTS = "search_no_results"
    const val MORE_RESULTS = "search_more_results"
    const val RESULTS = "search_results"

    fun result(customerId: String): String = "search_result_$customerId"
}
