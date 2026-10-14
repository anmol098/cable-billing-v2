package com.cablebilling.lineman.feature.receipt

import android.content.Context
import android.content.Intent
import android.os.Looper
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasAnyDescendant
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.cablebilling.designsystem.component.NumberPadTags
import com.cablebilling.designsystem.theme.CableSizes
import com.cablebilling.designsystem.theme.CableTheme
import com.cablebilling.lineman.data.db.FakeTime
import com.cablebilling.lineman.data.db.RosterFixtures
import com.cablebilling.lineman.data.db.inMemoryDatabase
import com.cablebilling.lineman.data.db.putRoster
import com.cablebilling.lineman.data.network.Fixtures
import com.cablebilling.lineman.data.network.Routes
import com.cablebilling.lineman.data.network.TestNetwork
import com.cablebilling.lineman.data.network.TestNetwork.Companion.await
import com.cablebilling.lineman.data.network.apiPath
import com.cablebilling.lineman.data.payments.FakePaymentServer
import com.cablebilling.lineman.data.payments.PaymentFixtures
import com.cablebilling.lineman.data.payments.PaymentRepository
import com.cablebilling.lineman.data.payments.RecordingPushTrigger
import com.cablebilling.lineman.data.payments.SaveResult
import com.cablebilling.lineman.data.receipts.FakeReceiptOffice
import com.cablebilling.lineman.data.receipts.OutboxReceiptActions
import com.cablebilling.lineman.data.receipts.PdfPages
import com.cablebilling.lineman.data.receipts.ReceiptIntents
import com.cablebilling.lineman.data.receipts.ReceiptLinks
import com.cablebilling.lineman.data.receipts.ReceiptMessages
import com.cablebilling.lineman.data.receipts.ReceiptPdfWriter
import com.cablebilling.lineman.data.receipts.ReceiptPhoneBook
import com.cablebilling.lineman.data.receipts.ReceiptSync
import com.cablebilling.lineman.data.receipts.RecordingSyncTrigger
import com.cablebilling.lineman.data.receipts.TestRequestStore
import com.cablebilling.lineman.data.receipts.resetFileProviderRoots
import com.cablebilling.lineman.data.receipts.testLog
import com.cablebilling.lineman.data.sync.PaymentSync
import com.cablebilling.lineman.di.NetworkModule
import com.cablebilling.lineman.feature.collect.CollectTags
import kotlinx.coroutines.flow.first
import mockwebserver3.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.time.Duration

/**
 * The receipt share screen in Hindi with the real queues and a fake office: confirm or change the
 * customer's number on the pad (FR-004), the link offline → "ready when there is internet" → ready
 * after the payment syncs, Open WhatsApp / Open SMS / Share PDF intents, honest "opened / shared"
 * words, and failures that leave the payment untouched (RULE-18).
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "hi-w360dp-h800dp")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ReceiptShareScreenTest {
    @get:Rule
    val folder = TemporaryFolder()

    @get:Rule
    val composeRule = createComposeRule()

    private val context: Context = ApplicationProvider.getApplicationContext()
    private val server = MockWebServer()
    private val db = inMemoryDatabase()
    private val time = FakeTime()
    private val json = NetworkModule.provideJson()
    private val payments = FakePaymentServer()
    private val office = FakeReceiptOffice(payments)
    private val routes =
        Routes { request ->
            office.handle(request) ?: when {
                request.apiPath == "/payments:batch" && office.online -> payments.handle(request)
                request.apiPath == "/payments:batch" -> FakeReceiptOffice.offline()
                else -> Fixtures.response("error.NOT_FOUND.json")
            }
        }
    private val trigger = RecordingSyncTrigger()
    private val launched = mutableListOf<List<Intent>>()

    @Volatile
    private var appsInstalled = true
    private val launcher =
        ShareLauncher { intents ->
            launched += intents
            appsInstalled
        }
    private lateinit var network: TestNetwork
    private lateinit var requests: TestRequestStore
    private lateinit var repository: PaymentRepository
    private lateinit var links: ReceiptLinks
    private lateinit var phoneBook: ReceiptPhoneBook
    private lateinit var sync: ReceiptSync

    @Before
    fun setUp() {
        resetFileProviderRoots()
        server.dispatcher = routes
        server.start()
        network = TestNetwork(server, folder.root)
        requests = TestRequestStore(folder.root)
        await { network.store.signIn(PaymentFixtures.login) }
        await { db.putRoster(RosterFixtures.login.operator.id, RosterFixtures.page.customers) }
        repository = PaymentRepository(db, network.store, time, RecordingPushTrigger())
        links = ReceiptLinks(db, network.mobileApi, network.errors, requests.store, time, trigger)
        phoneBook = ReceiptPhoneBook(db, requests.store, network.store, time, trigger)
        sync =
            ReceiptSync(
                db,
                network.mobileApi,
                network.errors,
                network.store,
                requests.store,
                links,
                time,
                testLog(folder.root),
            )
    }

    @After
    fun tearDown() {
        requests.close()
        network.close()
        server.close()
        db.close()
    }

    private fun save(customerId: String = RosterFixtures.ramesh.id): String {
        time.now += 1_000
        return (await { repository.save(PaymentFixtures.draft(customerId = customerId)) } as SaveResult.Saved).paymentId
    }

    private fun pushPayments() =
        await {
            PaymentSync(db, network.mobileApi, network.errors, network.store, time, json).run()
        }

    private fun show(
        paymentId: String,
        channel: ShareChannel,
    ) {
        // Robolectric has no PDF engine: the page is drawn on a bitmap and a stand-in file is written.
        val pdfs =
            ReceiptPdfWriter(context).also {
                it.pages =
                    PdfPages { width, height, out, draw ->
                        draw(android.graphics.Canvas(androidx.core.graphics.createBitmap(width, height)))
                        out.write("%PDF-test".toByteArray())
                    }
            }
        val viewModel =
            ReceiptShareViewModel(
                paymentId,
                channel,
                repository,
                network.store,
                phoneBook,
                links,
                pdfs,
                ReceiptMessages(context),
                OutboxReceiptActions(db, time, trigger, testLog(folder.root)),
                json,
            )
        composeRule.setContent {
            CableTheme {
                ReceiptShareScreen(
                    paymentId,
                    channel,
                    onClose = {},
                    launcher = launcher,
                    viewModel = viewModel,
                )
            }
        }
    }

    private fun waitUntil(condition: () -> Boolean) {
        composeRule.waitUntil(TIMEOUT_MS) {
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(STEP_MS))
            condition()
        }
    }

    private fun shows(text: String) =
        composeRule.onAllNodes(hasText(text, substring = true)).fetchSemanticsNodes().isNotEmpty()

    private fun waitForText(text: String) = waitUntil { shows(text) }

    private fun tag(tag: String) = composeRule.onNodeWithTag(tag, useUnmergedTree = false)

    private fun SemanticsNodeInteraction.hasTextInside(text: String) =
        assert(hasText(text, substring = true) or hasAnyDescendant(hasText(text, substring = true)))

    private fun type(digits: String) = digits.forEach { tag(NumberPadTags.digit(it.digitToInt())).performClick() }

    /** Every receipt action of [paymentId] (pending or already taken by the office). */
    private fun outbox(paymentId: String) = await { db.receiptActionDao().observeForPayment(paymentId).first() }

    @Test
    fun `WhatsApp - change the number offline, share the PDF, then open the chat once the link is ready`() {
        office.online = false
        val paymentId = save()
        show(paymentId, ShareChannel.WhatsApp)

        // Step 1: the stored number, big, with Yes / Change.
        waitForText("98765 43210")
        assertTrue(shows("WhatsApp पर रसीद"))
        assertTrue(shows("क्या यह ग्राहक का नंबर है?"))
        tag(ReceiptShareTags.PHONE_YES).hasTextInside("हाँ, यही नंबर")
        assertTouchTargets()
        tag(ReceiptShareTags.PHONE_CHANGE).performClick()

        // Typing: a number not starting with 6-9 cannot be used.
        waitForText("ग्राहक का मोबाइल नंबर लिखें")
        type("5123456789")
        tag(ReceiptShareTags.PHONE_TYPED).hasTextInside("51234 56789")
        tag(ReceiptShareTags.PHONE_USE).assertIsNotEnabled()
        repeat(10) { tag(NumberPadTags.BACKSPACE).performClick() }
        type("91234567801") // the 11th digit is ignored
        tag(ReceiptShareTags.PHONE_TYPED).hasTextInside("91234 56780")
        assertTouchTargets()
        tag(ReceiptShareTags.PHONE_USE).performScrollTo().assertIsEnabled().performClick()

        // Step 2: new number queued for the office; no link while offline / not synced.
        waitForText("इंटरनेट आने पर लिंक तैयार होगा।")
        tag(ReceiptShareTags.PHONE).hasTextInside("91234 56780")
        waitUntil { shows("नया नंबर फ़ोन में सेव है") }
        tag(ReceiptShareTags.OPEN).hasTextInside("WhatsApp खोलें").assertIsNotEnabled()
        assertEquals("9123456780", await { requests.store.current() }.phones.single().phone)

        // Share PDF works offline (provisional number), to WhatsApp first.
        tag(ReceiptShareTags.PDF).hasTextInside("PDF शेयर करें").performScrollTo().performClick()
        waitUntil { shows("PDF शेयर किया") || shows("PDF नहीं बना") }
        assertTrue("PDF failed", !shows("PDF नहीं बना"))
        waitForText("PDF शेयर किया")
        val pdf = launched.single()
        assertEquals("com.whatsapp", pdf.first().`package`)
        assertEquals("application/pdf", pdf.first().type)
        assertEquals(Intent.ACTION_CHOOSER, pdf.last().action)
        waitUntil { outbox(paymentId).map { it.action } == listOf("pdf_shared") }

        // Internet back: the payment goes, then the receipt queues (phone change + link).
        office.online = true
        pushPayments()
        await { sync.run() }
        waitForText("रसीद का लिंक तैयार है")
        assertEquals("9123456780", office.phones[RosterFixtures.ramesh.id])

        // No WhatsApp on the phone: an honest problem, the payment untouched.
        val before = await { db.paymentDao().get(paymentId) }
        appsInstalled = false
        tag(ReceiptShareTags.OPEN).performScrollTo().assertIsEnabled().performClick()
        waitForText("इस फ़ोन में WhatsApp नहीं है")
        assertTrue(shows("पेमेंट सेव है। बस रसीद नहीं खुली।"))
        assertEquals(before, await { db.paymentDao().get(paymentId) })

        // WhatsApp installed: the chat with the new number and the link.
        appsInstalled = true
        tag(ReceiptShareTags.OPEN).performScrollTo().performClick()
        waitForText("WhatsApp खुल गया")
        val chat = launched.last().first()
        assertEquals(Intent.ACTION_VIEW, chat.action)
        assertEquals("com.whatsapp", chat.`package`)
        assertTrue(chat.dataString!!.startsWith("https://wa.me/919123456780?text="))
        val text = chat.data!!.getQueryParameter("text")!!
        assertTrue(text, text.contains("रसीद R-2610-00045") && text.endsWith("https://cablebilling.example/r/token1"))
        assertEquals(chat.dataString, ReceiptIntents.whatsApp("9123456780", text).first().dataString)
        waitUntil { outbox(paymentId).map { it.action }.toSet() == setOf("pdf_shared", "whatsapp_opened") }
        assertEquals(before, await { db.paymentDao().get(paymentId) })
        assertTouchTargets()
    }

    @Test
    fun `SMS - no number stored, typed on the pad, link at once, no SMS app then SMS opened`() {
        val sunita = RosterFixtures.page.customers[1]
        val paymentId = save(sunita.id)
        pushPayments()
        show(paymentId, ShareChannel.Sms)

        // Nothing stored: straight to typing.
        waitForText("फ़ोन में मोबाइल नंबर नहीं है। नंबर लिखें।")
        type("7000012345")
        tag(ReceiptShareTags.PHONE_USE).performScrollTo().performClick()
        waitForText("रसीद का लिंक तैयार है")
        assertEquals(1, office.linkCalls.size)
        assertTrue(
            "no PDF button for SMS",
            composeRule.onAllNodes(hasText("PDF शेयर करें")).fetchSemanticsNodes().isEmpty(),
        )

        val before = await { db.paymentDao().get(paymentId) }
        appsInstalled = false
        tag(ReceiptShareTags.OPEN).hasTextInside("SMS खोलें").performScrollTo().performClick()
        waitForText("इस फ़ोन में SMS ऐप नहीं है।")
        assertTrue(outbox(paymentId).isEmpty())
        assertEquals(before, await { db.paymentDao().get(paymentId) })

        appsInstalled = true
        tag(ReceiptShareTags.OPEN).performScrollTo().performClick()
        waitForText("SMS खुल गया")
        val sms = launched.last().single()
        assertEquals(Intent.ACTION_SENDTO, sms.action)
        assertEquals("smsto:7000012345", sms.dataString)
        assertTrue(
            sms.getStringExtra(ReceiptIntents.EXTRA_SMS_BODY)!!.endsWith("https://cablebilling.example/r/token1"),
        )
        waitUntil { outbox(paymentId).map { it.action } == listOf("sms_opened") }
        // Nothing on screen claims the message went anywhere.
        listOf("भेजा", "भेज दिया", "डिलीवर", "Sent", "Delivered").forEach { assertTrue(it, !shows(it)) }
    }

    @Test
    fun `Back while typing returns to the stored number`() {
        val paymentId = save()
        show(paymentId, ShareChannel.WhatsApp)
        waitForText("98765 43210")
        tag(ReceiptShareTags.PHONE_CHANGE).performClick()
        waitForText("ग्राहक का मोबाइल नंबर लिखें")
        tag(CollectTags.BACK).performClick()
        waitForText("क्या यह ग्राहक का नंबर है?")
        tag(ReceiptShareTags.PHONE_YES).performClick()
        // Confirmed without a change: nothing queued for the office.
        waitForText("इंटरनेट आने पर लिंक तैयार होगा।")
        assertTrue(await { requests.store.current() }.phones.isEmpty())
    }

    private fun assertTouchTargets() {
        val minimum = CableSizes.TouchMin
        val tappable =
            composeRule
                .onAllNodes(
                    SemanticsMatcher.keyIsDefined(SemanticsActions.OnClick),
                ).fetchSemanticsNodes()
        assertTrue(tappable.isNotEmpty())
        for (node in tappable) {
            val (width, height) = with(composeRule.density) { node.size.width.toDp() to node.size.height.toDp() }
            assertTrue("$width x $height too small: ${node.config}", width >= minimum && height >= minimum)
        }
    }

    private companion object {
        const val TIMEOUT_MS = 10_000L
        const val STEP_MS = 10L
    }
}
