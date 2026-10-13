package com.cablebilling.lineman.catalogue

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge

/**
 * Debug builds only (src/debug): every design-system component in Hindi and English, for design
 * review and for checking Hindi copy (H-03). Opens from the "Components (test)" launcher icon of a
 * debug build, or with
 * `adb shell am start -n com.cablebilling.lineman.dev/com.cablebilling.lineman.catalogue.ComponentCatalogueActivity`.
 */
class ComponentCatalogueActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent { ComponentCatalogue() }
    }
}
