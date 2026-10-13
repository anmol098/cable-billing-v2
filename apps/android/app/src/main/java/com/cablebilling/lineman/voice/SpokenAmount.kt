package com.cablebilling.lineman.voice

import kotlin.math.absoluteValue

/**
 * Amounts as spoken words, for the voice read-out (PLAN §11.3: "रमेश कुमार, चार सौ पचास रुपये बाकी").
 * Indian numbering (हज़ार / लाख / करोड़, thousand / lakh / crore), whole rupees (D-17).
 *
 * - `words(45_000, Hindi)` → "चार सौ पचास रुपये"; `words(45_000, English)` → "four hundred fifty rupees".
 * - ₹1 is singular ("एक रुपया", "one rupee"); ₹0 is "शून्य रुपये" / "zero rupees".
 * - The sign is dropped, like `Rupees.format`: the caller says "due" or "advance".
 * - Paise are never shown in the UI, but if an amount has them they are spoken too
 *   ("बारह रुपये पचास पैसे", "twelve rupees and fifty paise"), so the voice never rounds money.
 */
object SpokenAmount {
    private const val PAISE_PER_RUPEE = 100L
    private const val HUNDRED = 100L
    private const val THOUSAND = 1_000L
    private const val LAKH = 1_00_000L
    private const val CRORE = 1_00_00_000L
    private const val TEN = 10

    /** Spoken words for an amount in paise (integer money, CLAUDE.md). */
    fun words(
        paise: Long,
        language: VoiceLanguage,
    ): String {
        // Divide before taking the absolute value, so Long.MIN_VALUE cannot overflow.
        val rupees = (paise / PAISE_PER_RUPEE).absoluteValue
        val rest = (paise % PAISE_PER_RUPEE).absoluteValue
        val vocab = Vocabulary.of(language)
        val rupeePart = "${number(rupees, language)} ${if (rupees == 1L) vocab.rupee else vocab.rupees}"
        val paisePart = "${number(rest, language)} ${if (rest == 1L) vocab.paisa else vocab.paise}"
        return when {
            rest == 0L -> rupeePart
            rupees == 0L -> paisePart
            else -> "$rupeePart${vocab.andPaise}$paisePart"
        }
    }

    /** A whole number ≥ 0 in words, Indian numbering ("बारह लाख चौंतीस हज़ार …"). */
    fun number(
        value: Long,
        language: VoiceLanguage,
    ): String {
        require(value >= 0) { "number() takes a value ≥ 0, got $value" }
        val vocab = Vocabulary.of(language)
        if (value == 0L) return vocab.below100(0)
        return buildList { addGroups(value, vocab) }.joinToString(" ")
    }

    private fun MutableList<String>.addGroups(
        value: Long,
        vocab: Vocabulary,
    ) {
        val crores = value / CRORE
        // Above 99 crore the crore count itself is spoken in Indian numbering ("एक सौ करोड़").
        if (crores > 0) {
            addGroups(crores, vocab)
            add(vocab.crore)
        }
        var rest = value % CRORE
        for ((unit, word) in listOf(LAKH to vocab.lakh, THOUSAND to vocab.thousand, HUNDRED to vocab.hundred)) {
            val count = (rest / unit).toInt()
            if (count > 0) {
                add(vocab.below100(count))
                add(word)
            }
            rest %= unit
        }
        if (rest > 0) add(vocab.below100(rest.toInt()))
    }

    /** The words of one language. */
    private interface Vocabulary {
        fun below100(value: Int): String

        val hundred: String
        val thousand: String
        val lakh: String
        val crore: String
        val rupee: String
        val rupees: String
        val paisa: String
        val paise: String

        /** Between the rupees and the paise. */
        val andPaise: String

        companion object {
            fun of(language: VoiceLanguage): Vocabulary =
                when (language) {
                    VoiceLanguage.Hindi -> HindiWords
                    VoiceLanguage.English -> EnglishWords
                }
        }
    }

    private object HindiWords : Vocabulary {
        override fun below100(value: Int): String = HINDI_0_TO_99[value]

        override val hundred = "सौ"
        override val thousand = "हज़ार"
        override val lakh = "लाख"
        override val crore = "करोड़"
        override val rupee = "रुपया"
        override val rupees = "रुपये"
        override val paisa = "पैसा"
        override val paise = "पैसे"
        override val andPaise = " "
    }

    private object EnglishWords : Vocabulary {
        override fun below100(value: Int): String = englishBelow100(value)

        override val hundred = "hundred"
        override val thousand = "thousand"
        override val lakh = "lakh"
        override val crore = "crore"
        override val rupee = "rupee"
        override val rupees = "rupees"
        override val paisa = "paisa"
        override val paise = "paise"
        override val andPaise = " and "
    }

    private fun englishBelow100(value: Int): String =
        when {
            value < ENGLISH_ONES.size -> ENGLISH_ONES[value]
            value % TEN == 0 -> ENGLISH_TENS[value / TEN]
            else -> "${ENGLISH_TENS[value / TEN]}-${ENGLISH_ONES[value % TEN]}"
        }

    private val ENGLISH_ONES =
        wordList(
            """
            zero one two three four five six seven eight nine ten
            eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen
            """,
        )

    private val ENGLISH_TENS = listOf("", "") + wordList("twenty thirty forty fifty sixty seventy eighty ninety")

    /** Hindi number names are irregular below 100, so every one is listed (index = number), ten per line. */
    internal val HINDI_0_TO_99 =
        wordList(
            """
            शून्य एक दो तीन चार पाँच छह सात आठ नौ
            दस ग्यारह बारह तेरह चौदह पंद्रह सोलह सत्रह अठारह उन्नीस
            बीस इक्कीस बाईस तेईस चौबीस पच्चीस छब्बीस सत्ताईस अट्ठाईस उनतीस
            तीस इकतीस बत्तीस तैंतीस चौंतीस पैंतीस छत्तीस सैंतीस अड़तीस उनतालीस
            चालीस इकतालीस बयालीस तैंतालीस चवालीस पैंतालीस छियालीस सैंतालीस अड़तालीस उनचास
            पचास इक्यावन बावन तिरपन चौवन पचपन छप्पन सत्तावन अट्ठावन उनसठ
            साठ इकसठ बासठ तिरसठ चौंसठ पैंसठ छियासठ सड़सठ अड़सठ उनहत्तर
            सत्तर इकहत्तर बहत्तर तिहत्तर चौहत्तर पचहत्तर छिहत्तर सतहत्तर अठहत्तर उन्यासी
            अस्सी इक्यासी बयासी तिरासी चौरासी पचासी छियासी सत्तासी अट्ठासी नवासी
            नब्बे इक्यानवे बानवे तिरानवे चौरानवे पचानवे छियानवे सत्तानवे अट्ठानवे निन्यानवे
            """,
        )

    private fun wordList(list: String): List<String> = list.trim().split(Regex("\\s+"))
}
