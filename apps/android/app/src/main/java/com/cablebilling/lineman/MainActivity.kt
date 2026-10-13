package com.cablebilling.lineman

import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.appcompat.app.AppCompatActivity
import com.cablebilling.designsystem.theme.CableTheme
import com.cablebilling.lineman.locale.AppLanguage
import com.cablebilling.lineman.ui.CableApp
import dagger.hilt.android.AndroidEntryPoint

/** The only activity. AppCompat (not ComponentActivity) so the per-app language works on API < 33. */
@AndroidEntryPoint
class MainActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        AppLanguage.applyDefaultIfUnset()
        enableEdgeToEdge()
        setContent {
            CableTheme {
                CableApp()
            }
        }
    }
}
