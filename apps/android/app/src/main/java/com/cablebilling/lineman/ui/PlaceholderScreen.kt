package com.cablebilling.lineman.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import com.cablebilling.designsystem.theme.CableSpacing

/** Stand-in for a screen a later task builds: just its name, big and centred. */
@Composable
fun PlaceholderScreen(
    title: String,
    testTag: String,
    modifier: Modifier = Modifier,
) {
    Box(
        modifier =
            modifier
                .fillMaxSize()
                .padding(CableSpacing.S4)
                .testTag(testTag),
        contentAlignment = Alignment.Center,
    ) {
        Text(text = title, style = MaterialTheme.typography.headlineLarge)
    }
}
