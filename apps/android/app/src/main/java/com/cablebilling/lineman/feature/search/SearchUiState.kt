package com.cablebilling.lineman.feature.search

import com.cablebilling.lineman.data.db.CustomerSummary

/** Which keyboard the search uses: the big on-screen number pad (home) or the phone's keyboard (ABC). */
enum class SearchMode { Digits, Letters }

/** Everything the search home shows. */
data class SearchUiState(
    val mode: SearchMode = SearchMode.Digits,
    /** What is typed: digits on the number pad, any text with the phone's keyboard. */
    val query: String = "",
    /** Rows for [resultsFor], best first (they follow [query] after a short pause, see SearchViewModel). */
    val results: List<CustomerSummary> = emptyList(),
    /** The (trimmed) query [results] answer. */
    val resultsFor: String = "",
    /** The sync strip; null until the first status is read. */
    val banner: SearchBanner? = null,
) {
    /** Nothing typed yet: show the hint. */
    val isBlank: Boolean get() = query.isBlank()

    /** The search ran for what is typed now and found nobody (never shown while a search is still pending). */
    val showsNoResults: Boolean get() = !isBlank && resultsFor == query.trim() && results.isEmpty()

    /** The list is cut at [SearchData.SEARCH_LIMIT]: ask for more digits/letters. */
    val hasMore: Boolean get() = results.size >= SearchData.SEARCH_LIMIT
}

/**
 * A customer row's amount: the due (red) when something is due, else the advance as a negative
 * amount (green, "credit"), else zero. The phone's unsent payments are already taken off.
 */
val CustomerSummary.rowAmountPaise: Long
    get() =
        when {
            balance.duePaise > 0 -> balance.duePaise
            balance.creditPaise > 0 -> -balance.creditPaise
            else -> 0
        }
