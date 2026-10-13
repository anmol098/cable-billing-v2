package com.cablebilling.lineman.ui

import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.cablebilling.designsystem.theme.CableTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/** Bottom-bar navigation in the Hindi UI (Compose UI test on Robolectric, so it runs on the JVM). */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "hi")
class CableAppNavigationTest {
    @get:Rule
    val composeRule = createComposeRule()

    @Test
    fun `bottom bar shows the three Hindi tabs and switches screens`() {
        // The search home, customer and Waiting screens use Hilt ViewModels: stand-ins here
        // (SearchToCustomerTest, CollectFlowTest and WaitingScreenTest run the real ones).
        composeRule.setContent {
            CableTheme {
                CableApp(
                    searchHome = { _, _ -> PlaceholderScreen(title = "search", testTag = "screen_search") },
                    customerScreen = { _, _, _ -> PlaceholderScreen(title = "customer", testTag = "screen_customer") },
                    waitingScreen = { PlaceholderScreen(title = "waiting", testTag = "screen_waiting") },
                )
            }
        }

        // Starts on Search (home, D-11).
        composeRule.onNodeWithTag("nav_search").assertIsDisplayed().assert(hasText("खोजें"))
        composeRule.onNodeWithTag("nav_today").assertIsDisplayed().assert(hasText("आज"))
        composeRule.onNodeWithTag("nav_waiting").assertIsDisplayed().assert(hasText("इंतज़ार में"))
        composeRule.onNodeWithTag("nav_search").assertIsSelected()
        composeRule.onNodeWithTag("screen_search").assertIsDisplayed()

        composeRule.onNodeWithTag("nav_today").performClick()
        composeRule.onNodeWithTag("screen_today").assertIsDisplayed()
        composeRule.onNodeWithTag("nav_today").assertIsSelected()
        composeRule.onNodeWithTag("nav_search").assertIsNotSelected()

        composeRule.onNodeWithTag("nav_waiting").performClick()
        composeRule.onNodeWithTag("screen_waiting").assertIsDisplayed()
        composeRule.onNodeWithTag("nav_waiting").assertIsSelected()

        composeRule.onNodeWithTag("nav_search").performClick()
        composeRule.onNodeWithTag("screen_search").assertIsDisplayed()
        composeRule.onNodeWithTag("nav_search").assertIsSelected()
    }
}
