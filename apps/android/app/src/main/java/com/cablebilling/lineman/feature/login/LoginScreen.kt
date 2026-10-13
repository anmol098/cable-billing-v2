package com.cablebilling.lineman.feature.login

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.painter.Painter
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.hilt.lifecycle.viewmodel.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.cablebilling.designsystem.component.BigButton
import com.cablebilling.designsystem.component.BigButtonStyle
import com.cablebilling.designsystem.theme.CableSizes
import com.cablebilling.designsystem.theme.CableSpacing
import com.cablebilling.designsystem.theme.CableTheme
import com.cablebilling.lineman.R
import com.cablebilling.designsystem.R as DesignR

/** The login screen with its ViewModel (used by SessionGate). */
@Composable
fun LoginRoute(viewModel: LoginViewModel = hiltViewModel()) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    LoginScreen(
        state = state,
        onLoginChange = viewModel::onLoginChange,
        onPasswordChange = viewModel::onPasswordChange,
        onToggleLoginKeyboard = viewModel::onToggleLoginKeyboard,
        onTogglePasswordKeyboard = viewModel::onTogglePasswordKeyboard,
        onTogglePasswordVisible = viewModel::onTogglePasswordVisible,
        onSignIn = viewModel::signIn,
        onCallOffice = { OfficeDialer.dial(context, state.officePhone) },
    )
}

/**
 * Login (PLAN §11.3, D-07): two big fields with icons (person, lock), "show password" on by
 * default, a `123` / `ABC` keyboard toggle on each field, one big green sign-in button, and
 * "Call office" for a forgotten password (PLAN §11.6: the owner resets it on the web).
 */
@Composable
fun LoginScreen(
    state: LoginUiState,
    onLoginChange: (String) -> Unit,
    onPasswordChange: (String) -> Unit,
    onToggleLoginKeyboard: () -> Unit,
    onTogglePasswordKeyboard: () -> Unit,
    onTogglePasswordVisible: () -> Unit,
    onSignIn: () -> Unit,
    onCallOffice: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier =
            modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(CableSpacing.S4)
                .testTag(LoginTags.SCREEN),
        verticalArrangement = Arrangement.spacedBy(CableSpacing.S4),
    ) {
        Text(text = stringResource(R.string.mobile_login_title), style = MaterialTheme.typography.headlineLarge)
        state.message?.let { LoginMessageRow(it) }
        LoginTextField(
            value = state.login,
            onValueChange = onLoginChange,
            label = stringResource(R.string.mobile_login_login_label),
            icon = painterResource(DesignR.drawable.ic_cb_customer),
            keyboard = state.loginKeyboard,
            onToggleKeyboard = onToggleLoginKeyboard,
            secret = false,
            visible = true,
            imeAction = ImeAction.Next,
            onDone = {},
            enabled = !state.busy,
            fieldTag = LoginTags.LOGIN,
            toggleTag = LoginTags.LOGIN_KEYBOARD,
        )
        LoginTextField(
            value = state.password,
            onValueChange = onPasswordChange,
            label = stringResource(R.string.mobile_login_password_label),
            icon = painterResource(DesignR.drawable.ic_cb_password),
            keyboard = state.passwordKeyboard,
            onToggleKeyboard = onTogglePasswordKeyboard,
            secret = true,
            visible = state.passwordVisible,
            imeAction = ImeAction.Done,
            onDone = { if (state.canSubmit) onSignIn() },
            enabled = !state.busy,
            fieldTag = LoginTags.PASSWORD,
            toggleTag = LoginTags.PASSWORD_KEYBOARD,
        )
        ShowPasswordToggle(visible = state.passwordVisible, onToggle = onTogglePasswordVisible)
        BigButton(
            text = stringResource(if (state.busy) R.string.mobile_login_signing_in else R.string.mobile_login_sign_in),
            icon = painterResource(DesignR.drawable.ic_cb_next),
            onClick = onSignIn,
            style = BigButtonStyle.Success,
            enabled = state.canSubmit,
            modifier = Modifier.testTag(LoginTags.SIGN_IN),
        )
        Spacer(Modifier.height(CableSpacing.S4))
        Text(text = stringResource(R.string.mobile_login_forgot_password), style = MaterialTheme.typography.bodyLarge)
        BigButton(
            text = stringResource(R.string.common_call_office),
            icon = painterResource(DesignR.drawable.ic_cb_call),
            onClick = onCallOffice,
            style = BigButtonStyle.Secondary,
            modifier = Modifier.testTag(LoginTags.CALL_OFFICE),
        )
    }
}

@Composable
private fun LoginMessageRow(message: LoginMessage) {
    Row(
        modifier = Modifier.fillMaxWidth().testTag(LoginTags.MESSAGE),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            painter = painterResource(DesignR.drawable.ic_cb_danger),
            contentDescription = null,
            tint = CableTheme.semanticColors.danger,
            modifier = Modifier.size(CableSizes.Icon),
        )
        Spacer(Modifier.width(CableSpacing.S3))
        Text(text = stringResource(message.text), style = MaterialTheme.typography.bodyLarge)
    }
}

@Composable
private fun LoginTextField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    icon: Painter,
    keyboard: KeyboardMode,
    onToggleKeyboard: () -> Unit,
    secret: Boolean,
    visible: Boolean,
    imeAction: ImeAction,
    onDone: () -> Unit,
    enabled: Boolean,
    fieldTag: String,
    toggleTag: String,
) {
    val keyboardType =
        when (keyboard) {
            KeyboardMode.Numbers -> if (secret) KeyboardType.NumberPassword else KeyboardType.Number
            KeyboardMode.Letters -> if (secret) KeyboardType.Password else KeyboardType.Text
        }
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        modifier = Modifier.fillMaxWidth().heightIn(min = CableSizes.TouchMin).testTag(fieldTag),
        enabled = enabled,
        textStyle = MaterialTheme.typography.titleMedium,
        label = { Text(label, style = MaterialTheme.typography.bodyLarge) },
        leadingIcon = { Icon(icon, contentDescription = null, modifier = Modifier.size(CableSizes.Icon)) },
        trailingIcon = { KeyboardToggle(current = keyboard, onToggle = onToggleKeyboard, tag = toggleTag) },
        visualTransformation = if (secret && !visible) PasswordVisualTransformation() else VisualTransformation.None,
        keyboardOptions =
            KeyboardOptions(
                keyboardType = keyboardType,
                imeAction = imeAction,
                autoCorrectEnabled = false,
            ),
        keyboardActions = KeyboardActions(onDone = { onDone() }),
        singleLine = true,
        shape = MaterialTheme.shapes.medium,
    )
}

/** Shows the keyboard to switch to: "ABC" while on digits, "123" while on letters. */
@Composable
private fun KeyboardToggle(
    current: KeyboardMode,
    onToggle: () -> Unit,
    tag: String,
) {
    val switchTo = current.toggled()
    val label =
        stringResource(
            if (switchTo ==
                KeyboardMode.Letters
            ) {
                R.string.mobile_login_keyboard_letters
            } else {
                R.string.mobile_login_keyboard_numbers
            },
        )
    val description =
        stringResource(
            if (switchTo == KeyboardMode.Letters) {
                R.string.mobile_login_keyboard_letters_description
            } else {
                R.string.mobile_login_keyboard_numbers_description
            },
        )
    TextButton(
        onClick = onToggle,
        modifier =
            Modifier
                .sizeIn(minWidth = CableSizes.TouchMin, minHeight = CableSizes.TouchMin)
                .semantics { contentDescription = description }
                .testTag(tag),
    ) {
        Text(text = label, style = MaterialTheme.typography.labelLarge)
    }
}

@Composable
private fun ShowPasswordToggle(
    visible: Boolean,
    onToggle: () -> Unit,
) {
    TextButton(
        onClick = onToggle,
        modifier = Modifier.heightIn(min = CableSizes.TouchMin).testTag(LoginTags.SHOW_PASSWORD),
    ) {
        Icon(
            painter = painterResource(if (visible) DesignR.drawable.ic_cb_hide else DesignR.drawable.ic_cb_show),
            contentDescription = null,
            modifier = Modifier.size(CableSizes.Icon),
        )
        Spacer(Modifier.width(CableSpacing.S2))
        Text(
            text =
                stringResource(
                    if (visible) R.string.mobile_login_hide_password else R.string.mobile_login_show_password,
                ),
            style = MaterialTheme.typography.labelLarge,
        )
    }
}
