package com.cablebilling.designsystem.component

/** What a [BigButton] looks like. One [Primary] (or [Success]) button per screen (PLAN §2.2 rule 1). */
enum class BigButtonStyle {
    /** Accent fill (black): the screen's main action ("पैसे लें / Collect"). */
    Primary,

    /** Success fill (green): the final "Save" that moves money (PLAN §11.3 Confirm). */
    Success,

    /** White with a strong outline: a second, less important action. */
    Secondary,
}
