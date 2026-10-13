package com.cablebilling.lineman.voice

import android.content.Context
import android.content.res.Configuration
import android.content.res.Resources
import androidx.annotation.StringRes
import com.cablebilling.designsystem.component.PaymentMethod
import com.cablebilling.lineman.R
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Builds read-outs ([VoiceLine]) in Hindi and English from the app's strings, whatever the app
 * language is, so the speaker can fall back to English (PLAN §11.3). Amounts are spoken as words
 * ([SpokenAmount]), never as "₹450".
 *
 * Inject it in a ViewModel (or `remember { VoiceLines(context) }` in a composable) and speak with
 * `speaker.say(voiceLines.customerDue(name, duePaise))`.
 */
@Singleton
class VoiceLines
    @Inject
    constructor(
        @ApplicationContext context: Context,
    ) {
        private val appContext: Context = context.applicationContext ?: context
        private val resources: Map<VoiceLanguage, Resources> by lazy {
            VoiceLanguage.entries.associateWith { language ->
                val config = Configuration(appContext.resources.configuration)
                config.setLocale(language.resourceLocale)
                appContext.createConfigurationContext(config).resources
            }
        }

        /**
         * Any `mobile_voice_*` (or other) string in both languages. [args] are passed to both; use
         * [line] with a builder when an argument differs by language (amounts).
         */
        fun line(
            @StringRes id: Int,
            vararg args: Any,
        ): VoiceLine = line { language -> text(language, id, *args) }

        /** The amount alone: "चार सौ पचास रुपये" / "four hundred fifty rupees". */
        fun amount(paise: Long): VoiceLine = line { language -> SpokenAmount.words(paise, language) }

        /** Customer screen: "रमेश कुमार, चार सौ पचास रुपये बाकी" / "Ramesh Kumar, four hundred fifty rupees due". */
        fun customerDue(
            name: String,
            duePaise: Long,
        ): VoiceLine =
            line { language ->
                text(language, R.string.mobile_voice_customer_due, name, SpokenAmount.words(duePaise, language))
            }

        /** Confirm screen: "रमेश कुमार से पाँच सौ रुपये नकद" / "five hundred rupees cash from Ramesh Kumar". */
        fun collected(
            name: String,
            amountPaise: Long,
            method: PaymentMethod,
        ): VoiceLine {
            val id =
                when (method) {
                    PaymentMethod.Cash -> R.string.mobile_voice_cash_from
                    PaymentMethod.Upi -> R.string.mobile_voice_upi_from
                }
            return line { language -> text(language, id, SpokenAmount.words(amountPaise, language), name) }
        }

        /** Done screen: "पैसे फ़ोन में सेव हो गए" / "Money saved on phone" (never "sent", BR-11). */
        fun moneySaved(): VoiceLine = line(R.string.mobile_voice_money_saved)

        /** A [VoiceLine] from a function of the language. */
        fun line(build: (VoiceLanguage) -> String): VoiceLine =
            VoiceLine(hindi = build(VoiceLanguage.Hindi), english = build(VoiceLanguage.English))

        /** The string [id] in [language]. */
        fun text(
            language: VoiceLanguage,
            @StringRes id: Int,
            vararg args: Any,
        ): String = resources.getValue(language).getString(id, *args)
    }
