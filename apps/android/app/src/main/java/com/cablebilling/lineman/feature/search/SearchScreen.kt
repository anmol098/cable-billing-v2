package com.cablebilling.lineman.feature.search

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.hilt.lifecycle.viewmodel.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.cablebilling.designsystem.component.CustomerRow
import com.cablebilling.designsystem.component.NumberPad
import com.cablebilling.designsystem.component.NumberPadExtraKey
import com.cablebilling.designsystem.component.NumberPadKey
import com.cablebilling.designsystem.component.SyncBanner
import com.cablebilling.designsystem.generated.Tokens
import com.cablebilling.designsystem.theme.CableSizes
import com.cablebilling.designsystem.theme.CableSpacing
import com.cablebilling.designsystem.theme.CableTheme
import com.cablebilling.lineman.R
import com.cablebilling.lineman.data.db.CustomerSummary
import com.cablebilling.designsystem.R as DesignR

/**
 * Home (PLAN §11.3 Search, D-11) with its ViewModel.
 *
 * @param onOpenCustomer a result row was tapped: open the customer screen for this id.
 * @param onOpenWaiting the strip says payments are on the phone and was tapped: open the Waiting tab.
 */
@Composable
fun SearchScreen(
    onOpenCustomer: (customerId: String) -> Unit,
    onOpenWaiting: () -> Unit,
    modifier: Modifier = Modifier,
    viewModel: SearchViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    SearchContent(
        state = state,
        onKey = viewModel::onKey,
        onTextChange = viewModel::onTextChange,
        onShowNumberPad = viewModel::onShowNumberPad,
        onBannerClick = {
            if (state.banner is SearchBanner.PaymentsOnPhone) onOpenWaiting() else viewModel.onRefresh()
        },
        onOpenCustomer = onOpenCustomer,
        modifier = modifier,
    )
}

/**
 * The search home without its ViewModel: the sync strip on top, what is typed, the results (name,
 * code, area, due large and red), and the big number pad over the bottom half of the screen. Its
 * `ABC` key swaps the pad for the phone's keyboard (name search); `123` swaps back.
 */
@Composable
fun SearchContent(
    state: SearchUiState,
    onKey: (NumberPadKey) -> Unit,
    onTextChange: (String) -> Unit,
    onShowNumberPad: () -> Unit,
    onBannerClick: () -> Unit,
    onOpenCustomer: (customerId: String) -> Unit,
    modifier: Modifier = Modifier,
) {
    // Back from the phone's keyboard returns to the number pad instead of leaving the app.
    BackHandler(enabled = state.mode == SearchMode.Letters, onBack = onShowNumberPad)
    Column(modifier = modifier.fillMaxSize().testTag(SearchTags.SCREEN)) {
        state.banner?.let { banner ->
            SyncBanner(
                state = banner.state,
                text = banner.text(),
                onClick = onBannerClick,
                modifier = Modifier.testTag(SearchTags.BANNER),
            )
        }
        when (state.mode) {
            SearchMode.Digits -> DigitsQuery(state.query)
            SearchMode.Letters -> LettersQuery(state.query, onTextChange, onShowNumberPad)
        }
        Results(
            state = state,
            onOpenCustomer = onOpenCustomer,
            modifier =
                Modifier
                    .weight(1f)
                    .then(if (state.mode == SearchMode.Letters) Modifier.imePadding() else Modifier),
        )
        if (state.mode == SearchMode.Digits) {
            NumberPad(
                onKey = onKey,
                deleteLabel = stringResource(R.string.mobile_designsystem_numpad_delete),
                extraKey = NumberPadExtraKey.Letters(stringResource(R.string.mobile_designsystem_numpad_letters)),
                modifier = Modifier.padding(CableSpacing.S4),
            )
        }
    }
}

/** The digits typed on the pad, big, or the hint while nothing is typed. */
@Composable
private fun DigitsQuery(query: String) {
    Row(
        modifier =
            Modifier
                .fillMaxWidth()
                .heightIn(min = CableSizes.PrimaryButton)
                .padding(horizontal = CableSpacing.S4, vertical = CableSpacing.S2)
                .testTag(SearchTags.QUERY),
        horizontalArrangement = Arrangement.spacedBy(CableSpacing.S3),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            painter = painterResource(DesignR.drawable.ic_cb_search),
            contentDescription = null,
            tint = Tokens.Color.TextMuted,
            modifier = Modifier.size(CableSizes.Icon),
        )
        if (query.isEmpty()) {
            Text(
                text = stringResource(R.string.mobile_search_hint_digits),
                style = MaterialTheme.typography.bodyLarge,
                color = Tokens.Color.TextMuted,
                modifier = Modifier.testTag(SearchTags.HINT),
            )
        } else {
            Text(
                text = query,
                style = CableTheme.numericTypography.key,
                color = Tokens.Color.Text,
                maxLines = 1,
                softWrap = false,
                // Long numbers keep their last digits in view (the ones just typed).
                overflow = TextOverflow.StartEllipsis,
            )
        }
    }
}

/** Name search with the phone's keyboard (opens focused), and `123` to go back to the pad. */
@Composable
private fun LettersQuery(
    query: String,
    onTextChange: (String) -> Unit,
    onShowNumberPad: () -> Unit,
) {
    val focus = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current
    LaunchedEffect(focus) { focus.requestFocus() }
    val numbersDescription = stringResource(R.string.mobile_search_numbers_key_description)
    OutlinedTextField(
        value = query,
        onValueChange = onTextChange,
        modifier =
            Modifier
                .fillMaxWidth()
                .padding(horizontal = CableSpacing.S4, vertical = CableSpacing.S2)
                .heightIn(min = CableSizes.TouchMin)
                .focusRequester(focus)
                .testTag(SearchTags.TEXT_FIELD),
        textStyle = MaterialTheme.typography.titleMedium,
        placeholder = {
            Text(
                stringResource(R.string.mobile_search_hint_letters),
                style = MaterialTheme.typography.bodyLarge,
            )
        },
        leadingIcon = {
            Icon(
                painter = painterResource(DesignR.drawable.ic_cb_search),
                contentDescription = null,
                modifier = Modifier.size(CableSizes.Icon),
            )
        },
        trailingIcon = {
            TextButton(
                onClick = onShowNumberPad,
                modifier =
                    Modifier
                        .sizeIn(minWidth = CableSizes.TouchMin, minHeight = CableSizes.TouchMin)
                        .semantics { contentDescription = numbersDescription }
                        .testTag(SearchTags.NUMBERS_KEY),
            ) {
                Text(
                    text = stringResource(R.string.mobile_search_numbers_key),
                    style = MaterialTheme.typography.labelLarge,
                )
            }
        },
        keyboardOptions =
            KeyboardOptions(
                capitalization = KeyboardCapitalization.Words,
                autoCorrectEnabled = false,
                keyboardType = KeyboardType.Text,
                imeAction = ImeAction.Search,
            ),
        keyboardActions = KeyboardActions(onSearch = { keyboard?.hide() }),
        singleLine = true,
        shape = MaterialTheme.shapes.medium,
    )
}

/** The result rows, or "No customer found". Nothing while nothing is typed (the hint is above). */
@Composable
private fun Results(
    state: SearchUiState,
    onOpenCustomer: (customerId: String) -> Unit,
    modifier: Modifier = Modifier,
) {
    if (state.showsNoResults) {
        Message(
            text = stringResource(R.string.mobile_search_no_results),
            modifier = modifier.testTag(SearchTags.NO_RESULTS),
        )
        return
    }
    val listState = rememberLazyListState()
    // A new search starts at the top of its list.
    LaunchedEffect(state.resultsFor) { listState.scrollToItem(0) }
    val dueLabel = stringResource(R.string.common_due)
    val creditLabel = stringResource(R.string.common_credit)
    LazyColumn(state = listState, modifier = modifier.fillMaxWidth().testTag(SearchTags.RESULTS)) {
        if (!state.isBlank) {
            items(state.results, key = CustomerSummary::id) { customer ->
                CustomerRow(
                    name = customer.name,
                    code = customer.code,
                    balancePaise = customer.rowAmountPaise,
                    onClick = { onOpenCustomer(customer.id) },
                    area = customer.areaName,
                    dueLabel = dueLabel,
                    creditLabel = creditLabel,
                    modifier = Modifier.testTag(SearchTags.result(customer.id)),
                )
            }
            if (state.hasMore) {
                item {
                    Text(
                        text = stringResource(R.string.mobile_search_more_results, state.results.size.toString()),
                        style = MaterialTheme.typography.bodyLarge,
                        color = Tokens.Color.TextMuted,
                        modifier = Modifier.padding(CableSpacing.S4).testTag(SearchTags.MORE_RESULTS),
                    )
                }
            }
        }
    }
}

@Composable
private fun Message(
    text: String,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier = modifier.fillMaxWidth().padding(CableSpacing.S4),
        horizontalArrangement = Arrangement.spacedBy(CableSpacing.S3),
    ) {
        Icon(
            painter = painterResource(DesignR.drawable.ic_cb_customer),
            contentDescription = null,
            tint = Tokens.Color.TextMuted,
            modifier = Modifier.size(CableSizes.Icon),
        )
        Text(text = text, style = MaterialTheme.typography.bodyLarge, color = Tokens.Color.Text)
    }
}
