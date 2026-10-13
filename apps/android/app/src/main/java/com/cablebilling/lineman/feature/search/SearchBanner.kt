package com.cablebilling.lineman.feature.search

import androidx.compose.runtime.Composable
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import com.cablebilling.designsystem.component.SyncState
import com.cablebilling.lineman.R
import com.cablebilling.lineman.data.db.RosterSyncStatus

/**
 * What the sync strip at the top of Search says (PLAN §11.3): "Updated 5 min ago", or amber
 * "3 payments on phone". Built from [RosterSyncStatus] by [from]; the words are in [text].
 */
sealed interface SearchBanner {
    val state: SyncState

    /** Payments are still on this phone: amber, tap opens Waiting. Wins over everything else. */
    data class PaymentsOnPhone(
        val count: Int,
    ) : SearchBanner {
        override val state get() = SyncState.Waiting
    }

    /** The first download of the customer list is running (search is empty until it lands). */
    data object FirstDownload : SearchBanner {
        override val state get() = SyncState.Waiting
    }

    /** The customer list was never downloaded on this phone (offline, or it failed). */
    data object NeverDownloaded : SearchBanner {
        override val state get() = SyncState.Waiting
    }

    /**
     * The list was last downloaded [minutesAgo] minutes ago. Green while fresh; amber when the last try
     * failed ([problem]) or it is older than [STALE_MINUTES] (the phone has been offline a while).
     */
    data class Updated(
        val minutesAgo: Long,
        val problem: UpdateProblem? = null,
    ) : SearchBanner {
        override val state get() =
            if (problem == null &&
                minutesAgo <= STALE_MINUTES
            ) {
                SyncState.Updated
            } else {
                SyncState.Waiting
            }
    }

    /** Why the last update did not work. */
    enum class UpdateProblem { NoInternet, Failed }

    companion object {
        /** Two missed 30-minute syncs: the list may be out of date. */
        const val STALE_MINUTES = 60L

        /** The banner for [status]. */
        fun from(status: RosterSyncStatus): SearchBanner {
            val minutes = status.minutesAgo
            return when {
                status.savedOnPhoneCount > 0 -> {
                    PaymentsOnPhone(status.savedOnPhoneCount)
                }

                minutes == null -> {
                    if (status.syncing) FirstDownload else NeverDownloaded
                }

                else -> {
                    val problem =
                        when (status.lastFailure) {
                            null -> null
                            OFFLINE -> UpdateProblem.NoInternet
                            else -> UpdateProblem.Failed
                        }
                    Updated(minutes, if (status.syncing) null else problem)
                }
            }
        }

        /** [RosterSyncStatus.lastFailure] when the phone had no internet (RosterSync's sync code). */
        private const val OFFLINE = "offline"
    }
}

/** The banner's sentence in the app language. */
@Composable
fun SearchBanner.text(): String =
    when (this) {
        is SearchBanner.PaymentsOnPhone -> {
            pluralStringResource(R.plurals.mobile_search_payments_on_phone, count, count)
        }

        SearchBanner.FirstDownload -> {
            stringResource(R.string.mobile_search_first_download)
        }

        SearchBanner.NeverDownloaded -> {
            stringResource(R.string.mobile_search_never_downloaded)
        }

        is SearchBanner.Updated -> {
            val updated = updatedText(minutesAgo)
            when (problem) {
                null -> {
                    updated
                }

                SearchBanner.UpdateProblem.NoInternet -> {
                    stringResource(
                        R.string.mobile_search_no_internet_updated,
                        updated,
                    )
                }

                SearchBanner.UpdateProblem.Failed -> {
                    stringResource(R.string.mobile_search_not_updated, updated)
                }
            }
        }
    }

/** "Updated just now / 5 min / 2 hours / 3 days ago". */
@Composable
private fun updatedText(minutesAgo: Long): String {
    val hours = minutesAgo / MINUTES_PER_HOUR
    val days = hours / HOURS_PER_DAY
    return when {
        minutesAgo < 1 -> {
            stringResource(R.string.mobile_search_updated_now)
        }

        hours < 1 -> {
            pluralStringResource(
                R.plurals.mobile_search_updated_minutes,
                minutesAgo.toInt(),
                minutesAgo.toInt(),
            )
        }

        days < 1 -> {
            pluralStringResource(R.plurals.mobile_search_updated_hours, hours.toInt(), hours.toInt())
        }

        else -> {
            pluralStringResource(R.plurals.mobile_search_updated_days, days.toCount(), days.toCount())
        }
    }
}

private fun Long.toCount(): Int = coerceAtMost(Int.MAX_VALUE.toLong()).toInt()

private const val MINUTES_PER_HOUR = 60L
private const val HOURS_PER_DAY = 24L
