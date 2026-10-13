package com.cablebilling.lineman.data.network.codegen

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * Turns `packages/contracts/openapi.json` (OpenAPI 3.1, generated from the Zod contract by T-051)
 * into Kotlin DTOs for kotlinx.serialization: one `@Serializable data class` per object schema and
 * one `enum class` per string enum, in a single file. Models only; the Retrofit services are
 * written by hand.
 *
 * Deterministic: schemas sorted by name, properties in contract order, no timestamps. It refuses
 * any schema shape it does not know (so a contract change that needs a new mapping fails loudly
 * instead of producing a wrong type).
 *
 * Type mapping (contract wire conventions, packages/contracts/README.md):
 * - `string` (any `format`, `pattern` or `const`) → `String`. Ids, instants (`…Z`), business dates
 *   and periods stay text on the wire; callers parse them where they need to.
 * - `integer` → `Long` (money is paise; never a float).
 * - `boolean` → `Boolean`, `array` → `List<T>`, an object with only `additionalProperties` →
 *   `Map<String, T>`.
 * - `anyOf: [X, {type: null}]` (3.1 nullability) → `X?`. A property that is not `required` → `X? = null`.
 * - A `$ref` to an enum schema → that enum, except the open enums in [OPEN_ENUMS] (`ErrorCode`: the
 *   server may add codes within v1), which are decoded as `String` and looked up with `fromWire`.
 */
object ApiModelGenerator {
    const val PACKAGE = "com.cablebilling.lineman.data.network.generated"

    /** Enums that may grow within v1: properties referencing them are `String`. */
    val OPEN_ENUMS = setOf("ErrorCode")

    private val KOTLIN_KEYWORDS =
        setOf(
            "as",
            "break",
            "class",
            "continue",
            "do",
            "else",
            "false",
            "for",
            "fun",
            "if",
            "in",
            "interface",
            "is",
            "null",
            "object",
            "package",
            "return",
            "super",
            "this",
            "throw",
            "true",
            "try",
            "typealias",
            "typeof",
            "val",
            "var",
            "when",
            "while",
        )

    fun generate(openApiJson: String): String {
        val root = Json.parseToJsonElement(openApiJson).jsonObject
        val info = root.obj("info")
        val schemas = root.obj("components").obj("schemas")
        val out = StringBuilder()
        out.appendLine(
            "// GENERATED from packages/contracts/openapi.json (\"${info.str("title")}\" ${info.str("version")}).",
        )
        out.appendLine(
            "// Do not edit. Generator: app/src/test/.../data/network/codegen/ApiModelGenerator.kt. Regenerate:",
        )
        out.appendLine(
            "// ./gradlew :app:testDevDebugUnitTest --tests '*ApiModelsUpToDateTest' -Pcb.writeApiModels=true",
        )
        out.appendLine()
        out.appendLine("package $PACKAGE")
        out.appendLine()
        out.appendLine("import kotlinx.serialization.SerialName")
        out.appendLine("import kotlinx.serialization.Serializable")
        out.appendLine()
        out.appendLine("/** The contract these models were generated from. */")
        out.appendLine("object ApiContract {")
        out.appendLine("    /** `info.version` of openapi.json (packages/contracts `CONTRACT_VERSION`). */")
        out.appendLine("    const val VERSION: String = ${kotlinString(info.str("version"))}")
        out.appendLine("}")

        val inlineEnums = mutableListOf<Pair<String, JsonObject>>()
        for (name in schemas.keys.sorted()) {
            val schema = schemas.obj(name)
            out.appendLine()
            when {
                schema.isStringEnum() -> {
                    writeEnum(out, name, schema)
                }

                schema["type"].asText() == "object" && schema.containsKey("properties") -> {
                    writeDataClass(out, name, schema, schemas, inlineEnums)
                }

                else -> {
                    error("Schema $name: unsupported top-level shape ${schema.keys}")
                }
            }
        }
        for ((name, schema) in inlineEnums.sortedBy { it.first }) {
            out.appendLine()
            writeEnum(out, name, schema)
        }
        return out.toString()
    }

    private fun writeDataClass(
        out: StringBuilder,
        name: String,
        schema: JsonObject,
        schemas: JsonObject,
        inlineEnums: MutableList<Pair<String, JsonObject>>,
    ) {
        val required =
            schema["required"]
                ?.jsonArray
                ?.map { it.jsonPrimitive.content }
                ?.toSet()
                .orEmpty()
        writeDoc(out, schema["description"].asText(), indent = "")
        out.appendLine("@Serializable")
        out.appendLine("data class $name(")
        for ((wireName, element) in schema.obj("properties")) {
            val property = element.jsonObject
            val type = typeOf(property, owner = name, propertyName = wireName, schemas, inlineEnums)
            val nullable = type.nullable || wireName !in required
            writeDoc(out, property["description"].asText(), indent = "    ")
            val kotlinType = if (nullable) "${type.name}? = null" else type.name
            out.appendLine("    @SerialName(${kotlinString(wireName)}) val ${propertyName(wireName)}: $kotlinType,")
        }
        out.appendLine(")")
    }

    private fun writeEnum(
        out: StringBuilder,
        name: String,
        schema: JsonObject,
    ) {
        val openNote =
            "Open enum: the server may add values within v1, so properties carrying it are `String`. " +
                "Look a value up with [fromWire] (null = a code this app does not know; map it by HTTP status)."
        val description = schema["description"].asText().orEmpty()
        writeDoc(out, if (name in OPEN_ENUMS) "$description\n\n$openNote".trim() else description, indent = "")
        out.appendLine("@Serializable")
        out.appendLine("enum class $name(val wire: String) {")
        for (value in schema.getValue("enum").jsonArray.map { it.jsonPrimitive.content }) {
            out.appendLine("    @SerialName(${kotlinString(value)}) ${constantName(value)}(${kotlinString(value)}),")
        }
        out.appendLine("    ;")
        out.appendLine()
        out.appendLine("    companion object {")
        out.appendLine("        /** The value whose wire name is [wire], or null if this app does not know it. */")
        out.appendLine("        fun fromWire(wire: String): $name? = entries.firstOrNull { it.wire == wire }")
        out.appendLine("    }")
        out.appendLine("}")
    }

    private data class KotlinType(
        val name: String,
        val nullable: Boolean = false,
    )

    private fun typeOf(
        property: JsonObject,
        owner: String,
        propertyName: String,
        schemas: JsonObject,
        inlineEnums: MutableList<Pair<String, JsonObject>>,
    ): KotlinType {
        val where = "$owner.$propertyName"
        val ref = property["\$ref"].asText()
        val anyOf = property["anyOf"]
        return when {
            ref != null -> {
                val target = ref.removePrefix("#/components/schemas/")
                require(schemas.containsKey(target)) { "$where: unknown \$ref $target" }
                KotlinType(if (target in OPEN_ENUMS) "String" else target)
            }

            anyOf != null -> {
                val members = anyOf.jsonArray.map { it.jsonObject }
                val nonNull = members.filterNot { it["type"].asText() == "null" }
                require(members.size == 2 && nonNull.size == 1) { "$where: only anyOf [X, {type: null}] is supported" }
                typeOf(nonNull.single(), owner, propertyName, schemas, inlineEnums).copy(nullable = true)
            }

            else -> {
                KotlinType(plainTypeOf(property, owner, propertyName, schemas, inlineEnums))
            }
        }
    }

    private fun plainTypeOf(
        property: JsonObject,
        owner: String,
        propertyName: String,
        schemas: JsonObject,
        inlineEnums: MutableList<Pair<String, JsonObject>>,
    ): String {
        val where = "$owner.$propertyName"
        return when (val type = property["type"].asText()) {
            "string" -> {
                if (property.containsKey("enum")) {
                    val enumName = owner + pascal(propertyName)
                    inlineEnums += enumName to property
                    enumName
                } else {
                    "String"
                }
            }

            "integer" -> {
                "Long"
            }

            "boolean" -> {
                "Boolean"
            }

            "array" -> {
                val items = property.obj("items")
                "List<${typeOf(items, owner, propertyName, schemas, inlineEnums).render()}>"
            }

            "object" -> {
                require(!property.containsKey("properties")) { "$where: inline object schemas are not supported" }
                val values = property["additionalProperties"]
                require(values is JsonObject) { "$where: object without additionalProperties schema" }
                "Map<String, ${typeOf(values, owner, propertyName, schemas, inlineEnums).render()}>"
            }

            else -> {
                error("$where: unsupported type $type (money must be integer paise, never number)")
            }
        }
    }

    private fun KotlinType.render(): String = if (nullable) "$name?" else name

    private fun writeDoc(
        out: StringBuilder,
        text: String?,
        indent: String,
    ) {
        if (text.isNullOrBlank()) return
        val lines = text.replace("*/", "*&#47;").lines()
        if (lines.size == 1) {
            out.appendLine("$indent/** ${lines.single()} */")
            return
        }
        out.appendLine("$indent/**")
        lines.forEach { line -> out.appendLine("$indent *${if (line.isEmpty()) "" else " $line"}") }
        out.appendLine("$indent */")
    }

    private fun propertyName(wire: String): String {
        val camel = pascal(wire).replaceFirstChar { it.lowercaseChar() }
        return if (camel in KOTLIN_KEYWORDS) "`$camel`" else camel
    }

    private fun pascal(wire: String): String =
        wire.split('_', '-').filter { it.isNotEmpty() }.joinToString("") { part ->
            part.replaceFirstChar { it.uppercaseChar() }
        }

    private fun constantName(wire: String): String {
        val name = wire.replace(Regex("[^A-Za-z0-9]+"), "_").uppercase()
        return if (name.first().isDigit()) "V_$name" else name
    }

    private fun kotlinString(value: String): String =
        "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"").replace("$", "\\$") + "\""

    private fun JsonObject.isStringEnum(): Boolean = this["type"].asText() == "string" && containsKey("enum")

    private fun JsonObject.obj(key: String): JsonObject =
        requireNotNull(this[key] as? JsonObject) { "missing object '$key'" }

    private fun JsonObject.str(key: String): String = requireNotNull(this[key].asText()) { "missing string '$key'" }

    private fun JsonElement?.asText(): String? = (this as? JsonPrimitive)?.takeIf { it.isString }?.content
}
