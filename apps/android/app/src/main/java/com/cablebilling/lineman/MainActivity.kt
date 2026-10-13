package com.cablebilling.lineman

import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.appcompat.app.AppCompatActivity
import androidx.compose.runtime.CompositionLocalProvider
import com.cablebilling.designsystem.theme.CableTheme
import com.cablebilling.designsystem.voice.LocalSpeaker
import com.cablebilling.designsystem.voice.Speaker
import com.cablebilling.lineman.feature.login.SessionGate
import com.cablebilling.lineman.locale.AppLanguage
import com.cablebilling.lineman.ui.CableApp
import com.cablebilling.lineman.voice.VoiceHost
import dagger.hilt.android.AndroidEntryPoint
import javax.inject.Inject

/** The only activity. AppCompat (not ComponentActivity) so the per-app language works on API < 33. */
@AndroidEntryPoint
class MainActivity : AppCompatActivity() {
    /** Voice read-out for every screen, as `LocalSpeaker` (T-009; TextToSpeech from T-067). */
    @Inject
    lateinit var speaker: Speaker

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        AppLanguage.applyDefaultIfUnset()
        enableEdgeToEdge()
        setContent {
            CompositionLocalProvider(LocalSpeaker provides speaker) {
                CableTheme {
                    // Force update, then login, in front of the app shell (T-063).
                    SessionGate { CableApp() }
                    // TTS lifecycle + the one-time Hindi voice prompt (T-067).
                    VoiceHost(speaker)
                }
            }
        }
    }
}
