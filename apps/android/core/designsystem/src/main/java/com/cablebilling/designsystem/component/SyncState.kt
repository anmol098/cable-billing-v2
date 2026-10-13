package com.cablebilling.designsystem.component

import androidx.annotation.DrawableRes
import com.cablebilling.designsystem.R

/** What the [SyncBanner] says about the phone's data. */
enum class SyncState(
    @param:DrawableRes val icon: Int,
) {
    /** Everything is at the office ("5 मिनट पहले अपडेट हुआ / Updated 5 min ago"): green tick. */
    Updated(R.drawable.ic_cb_success),

    /** Payments are still on the phone ("फ़ोन में 3 पेमेंट"), or there is no internet: amber clock. */
    Waiting(R.drawable.ic_cb_pending),

    /** Something needs the office: red warning. */
    Problem(R.drawable.ic_cb_danger),
}
