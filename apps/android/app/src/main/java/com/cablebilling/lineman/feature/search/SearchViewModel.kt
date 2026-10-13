package com.cablebilling.lineman.feature.search

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.cablebilling.designsystem.component.NumberPadKey
import com.cablebilling.designsystem.component.applyTo
import com.cablebilling.lineman.data.db.CustomerSummary
import com.cablebilling.lineman.data.db.SearchText
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.onStart
import kotlinx.coroutines.flow.stateIn
import javax.inject.Inject

/**
 * The search home (PLAN §11.3, D-11): number-pad search by code, phone part or VC number, an ABC key
 * for a name search with the phone's keyboard, and the sync strip.
 *
 * Typing is debounced ([DIGITS_DEBOUNCE_MS] on the pad, [LETTERS_DEBOUNCE_MS] on the keyboard) so a
 * fast typist does not start a query per key; the newest query cancels the previous one. What is typed
 * and the keyboard survive process death ([SavedStateHandle]).
 */
@OptIn(FlowPreview::class, ExperimentalCoroutinesApi::class)
@HiltViewModel
class SearchViewModel
    @Inject
    constructor(
        private val data: SearchData,
        private val savedState: SavedStateHandle,
    ) : ViewModel() {
        private val query: StateFlow<String> = savedState.getStateFlow(KEY_QUERY, "")
        private val mode: StateFlow<SearchMode> = savedState.getStateFlow(KEY_MODE, SearchMode.Digits)

        private val results: Flow<Pair<String, List<CustomerSummary>>> =
            query
                .map { it.trim() }
                .distinctUntilChanged()
                .debounce { typed -> debounceFor(typed) }
                .flatMapLatest { typed ->
                    if (typed.isEmpty()) {
                        flowOf(typed to emptyList())
                    } else {
                        data.search(typed).map { rows -> typed to rows }
                    }
                }.onStart { emit("" to emptyList()) }

        private val banner: Flow<SearchBanner?> =
            data
                .syncStatus()
                .map<_, SearchBanner?> { SearchBanner.from(it) }
                .distinctUntilChanged()
                .onStart { emit(null) }

        val state: StateFlow<SearchUiState> =
            combine(query, mode, results, banner) { typed, keyboard, (resultsFor, rows), strip ->
                SearchUiState(
                    mode = keyboard,
                    query = typed,
                    results = rows,
                    resultsFor = resultsFor,
                    banner = strip,
                )
            }.stateIn(
                scope = viewModelScope,
                started = SharingStarted.WhileSubscribed(STOP_TIMEOUT_MS),
                initialValue = SearchUiState(mode = mode.value, query = query.value),
            )

        /** A number-pad key: digits edit the query, ⌫ / long-press ⌫ delete, ABC opens the phone's keyboard. */
        fun onKey(key: NumberPadKey) {
            if (key == NumberPadKey.Letters) {
                savedState[KEY_MODE] = SearchMode.Letters
                return
            }
            // A phone number may start with 0, so leading zeros stay.
            savedState[KEY_QUERY] = key.applyTo(query.value, maxLength = MAX_DIGITS, trimLeadingZeros = false)
        }

        /** Text from the phone's keyboard (ABC mode). */
        fun onTextChange(text: String) {
            savedState[KEY_QUERY] = text.take(MAX_TEXT)
        }

        /** "123": back to the number pad, keeping only the digits typed. */
        fun onShowNumberPad() {
            savedState[KEY_QUERY] = SearchText.digitsOnly(query.value).take(MAX_DIGITS)
            savedState[KEY_MODE] = SearchMode.Digits
        }

        /** Tap on the sync strip without payments waiting: pull the customer list now. */
        fun onRefresh() = data.requestSync()

        companion object {
            /** Pause after a number-pad key before searching (taps are ≥ ~150 ms apart; results stay < 100 ms). */
            const val DIGITS_DEBOUNCE_MS = 50L

            /** Pause after a letter on the phone's keyboard before searching. */
            const val LETTERS_DEBOUNCE_MS = 200L

            /** Longest digit string (a 10-digit phone with country code, long VC numbers). */
            const val MAX_DIGITS = 20

            /** Longest name search. */
            const val MAX_TEXT = 60

            private const val STOP_TIMEOUT_MS = 5_000L
            private const val KEY_QUERY = "search_query"
            private const val KEY_MODE = "search_mode"

            /** The pause before searching for [typed] (none for an empty query: clearing is immediate). */
            fun debounceFor(typed: String): Long =
                when {
                    typed.isEmpty() -> 0L
                    typed.any { it.isLetter() } -> LETTERS_DEBOUNCE_MS
                    else -> DIGITS_DEBOUNCE_MS
                }
        }
    }
