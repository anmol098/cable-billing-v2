package com.cablebilling.lineman.catalogue

/** Test tags of the catalogue. */
object CatalogueTags {
    const val ROOT = "catalogue"
    const val AMOUNT_ENTRY = "catalogue_amount_entry"
    const val SEARCH_ENTRY = "catalogue_search_entry"
    const val SEARCH_DIGITS = "catalogue_search_digits"

    fun section(name: String): String = "catalogue_section_$name"

    fun language(code: String): String = "catalogue_language_$code"
}
