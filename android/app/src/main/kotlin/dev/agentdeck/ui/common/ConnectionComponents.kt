package dev.agentdeck.ui.common

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import dev.agentdeck.net.BridgeConstants
import dev.agentdeck.net.ConnectionStatus
import dev.agentdeck.net.DiscoveredBridge
import dev.agentdeck.ui.theme.AgentDeckColors
import dev.agentdeck.ui.theme.LocalIsEink

// ── Connection-state lexicon ──────────────────────────────────────────
// Kotlin mirror of shared/src/connection-status.ts. Self-connecting clients
// (this app, Apple app, ESP32) surface the phase they are actually in;
// update the TS SSOT and all mirrors together when copy changes.
object ConnectionLexicon {
    const val SEARCHING = "Searching for AgentDeck..."
    const val SEARCHING_COMPACT = "Searching..."
    const val CONNECTING = "Connecting..."
    const val RECONNECTING = "Reconnecting..."
}

// ── Status Badge ──────────────────────────────────────────────────────

@Composable
fun ConnectionStatusBadge(
    connectionStatus: ConnectionStatus,
    currentUrl: String?,
    modifier: Modifier = Modifier,
) {
    val isEink = LocalIsEink.current
    Column(modifier = modifier) {
        Text(
            text = when (connectionStatus) {
                ConnectionStatus.CONNECTED -> "\u25CF Connected"
                ConnectionStatus.CONNECTING -> "\u25CB ${ConnectionLexicon.CONNECTING}"
                ConnectionStatus.DISCONNECTED -> "\u25CB ${ConnectionLexicon.SEARCHING_COMPACT}"
            },
            style = MaterialTheme.typography.bodyMedium,
            color = if (isEink) {
                MaterialTheme.colorScheme.onSurface
            } else {
                when (connectionStatus) {
                    ConnectionStatus.CONNECTED -> AgentDeckColors.Green
                    ConnectionStatus.CONNECTING -> AgentDeckColors.Amber
                    ConnectionStatus.DISCONNECTED -> AgentDeckColors.SlateText
                }
            },
        )
        if (currentUrl != null) {
            Text(
                text = redactedConnectionUrl(currentUrl),
                style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

private fun redactedConnectionUrl(url: String): String {
    val tokenPrefix = "token="
    val tokenStart = url.indexOf(tokenPrefix)
    if (tokenStart < 0) return url

    val valueStart = tokenStart + tokenPrefix.length
    val valueEnd = url.indexOf('&', startIndex = valueStart).let { end ->
        if (end < 0) url.length else end
    }
    return url.replaceRange(valueStart, valueEnd, "redacted")
}

// ── Error Message ─────────────────────────────────────────────────────

@Composable
fun ConnectionErrorMessage(
    lastError: String?,
    connectionStatus: ConnectionStatus,
    modifier: Modifier = Modifier,
) {
    if (lastError != null && connectionStatus == ConnectionStatus.DISCONNECTED) {
        val isEink = LocalIsEink.current
        Text(
            text = lastError,
            style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
            color = if (isEink) MaterialTheme.colorScheme.onSurfaceVariant else AgentDeckColors.Red,
            modifier = modifier,
        )
    }
}

// ── USB Quick Connect ─────────────────────────────────────────────────

@Composable
fun UsbConnectButton(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val isEink = LocalIsEink.current
    if (isEink) {
        Surface(
            modifier = modifier.clickable(onClick = onClick),
            shape = RoundedCornerShape(4.dp),
            border = BorderStroke(2.dp, Color.Black),
            color = MaterialTheme.colorScheme.background,
        ) {
            Column(modifier = Modifier.padding(8.dp)) {
                Text(
                    text = "USB (adb reverse)",
                    style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.Bold),
                    color = MaterialTheme.colorScheme.onSurface,
                )
                Text(
                    text = BridgeConstants.LOCALHOST_DISPLAY,
                    style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    } else {
        Button(
            onClick = onClick,
            modifier = modifier.fillMaxWidth(),
            colors = ButtonDefaults.buttonColors(containerColor = AgentDeckColors.Blue),
            shape = RoundedCornerShape(8.dp),
        ) {
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                modifier = Modifier.padding(vertical = 4.dp),
            ) {
                Text(
                    text = "USB Connect",
                    style = MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.Bold),
                )
                Text(
                    text = BridgeConstants.LOCALHOST_DISPLAY,
                    style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                    color = Color.White.copy(alpha = 0.7f),
                )
            }
        }
    }
}

// ── Discovered Bridge List ────────────────────────────────────────────

@Composable
fun DiscoveredBridgeList(
    bridges: List<DiscoveredBridge>,
    onConnectToBridge: (DiscoveredBridge) -> Unit,
    modifier: Modifier = Modifier,
) {
    val isEink = LocalIsEink.current
    Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(4.dp)) {
        if (bridges.isNotEmpty()) {
            Text(
                text = "Discovered",
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            bridges.forEach { bridge ->
                if (isEink) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .border(1.dp, Color.DarkGray, RoundedCornerShape(4.dp))
                            .clickable { onConnectToBridge(bridge) }
                            .padding(8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Text("\u25CF", color = MaterialTheme.colorScheme.onSurface)
                        Column {
                            Text(
                                text = bridge.name,
                                style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.Bold),
                                color = MaterialTheme.colorScheme.onSurface,
                            )
                            Text(
                                text = "${bridge.host}:${bridge.port}",
                                style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                } else {
                    OutlinedButton(
                        onClick = { onConnectToBridge(bridge) },
                        modifier = Modifier.fillMaxWidth(),
                        shape = RoundedCornerShape(8.dp),
                    ) {
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            Text(text = bridge.name, color = AgentDeckColors.WhiteText)
                            Text(
                                text = "${bridge.host}:${bridge.port}",
                                style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                                color = AgentDeckColors.SlateText,
                            )
                        }
                    }
                }
            }
        } else {
            Text(
                text = ConnectionLexicon.SEARCHING,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

// ── Manual URL Input ──────────────────────────────────────────────────

@Composable
fun ManualUrlInput(
    onConnect: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val isEink = LocalIsEink.current
    var urlInput by remember { mutableStateOf("") }
    val doConnect = {
        if (urlInput.isNotBlank()) {
            val url = if (urlInput.startsWith("ws://")) urlInput else "ws://$urlInput"
            onConnect(url)
        }
    }

    if (isEink) {
        Row(
            modifier = modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            OutlinedTextField(
                value = urlInput,
                onValueChange = { urlInput = it },
                placeholder = {
                    Text("192.168.1.5:9120", style = MaterialTheme.typography.bodySmall)
                },
                modifier = Modifier.weight(1f),
                singleLine = true,
                textStyle = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Go),
                keyboardActions = KeyboardActions(onGo = { doConnect() }),
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = Color.Black,
                    unfocusedBorderColor = Color.DarkGray,
                    cursorColor = Color.Black,
                ),
            )
            Button(
                onClick = { doConnect() },
                enabled = urlInput.isNotBlank(),
                colors = ButtonDefaults.buttonColors(
                    containerColor = Color.Black,
                    contentColor = Color.White,
                ),
                shape = RoundedCornerShape(4.dp),
            ) {
                Text("Connect")
            }
        }
    } else {
        Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(4.dp)) {
            OutlinedTextField(
                value = urlInput,
                onValueChange = { urlInput = it },
                modifier = Modifier.fillMaxWidth(),
                placeholder = { Text("ws://192.168.1.x:9120?token=abc") },
                singleLine = true,
                label = { Text("Manual URL") },
            )
            Button(
                onClick = { doConnect() },
                modifier = Modifier.fillMaxWidth(),
                enabled = urlInput.isNotBlank(),
            ) {
                Text("Connect")
            }
        }
    }
}

// ── Disconnect Button ─────────────────────────────────────────────────

@Composable
fun DisconnectButton(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val isEink = LocalIsEink.current
    if (isEink) {
        OutlinedButton(
            onClick = onClick,
            modifier = modifier.fillMaxWidth(),
            shape = RoundedCornerShape(4.dp),
            border = BorderStroke(1.dp, Color.Black),
        ) {
            Text("Disconnect", color = Color.Black)
        }
    } else {
        OutlinedButton(
            onClick = onClick,
            modifier = modifier,
        ) {
            Text("Disconnect")
        }
    }
}

// ── Connection Panel (composite) ──────────────────────────────────────

/**
 * Complete connection management panel — status, error, USB connect,
 * mDNS bridges, manual URL input, and disconnect.
 * Automatically adapts to e-ink/tablet theme via LocalIsEink.
 */
@Composable
fun ConnectionPanel(
    connectionStatus: ConnectionStatus,
    currentUrl: String?,
    lastError: String?,
    discoveredBridges: List<DiscoveredBridge>,
    onConnectToBridge: (DiscoveredBridge) -> Unit,
    onConnectLocalhost: () -> Unit,
    onConnectManualUrl: (String) -> Unit,
    onDisconnect: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier,
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        ConnectionStatusBadge(
            connectionStatus = connectionStatus,
            currentUrl = currentUrl,
        )

        ConnectionErrorMessage(
            lastError = lastError,
            connectionStatus = connectionStatus,
        )

        if (connectionStatus == ConnectionStatus.CONNECTED) {
            DisconnectButton(onClick = onDisconnect)
        }

        if (connectionStatus == ConnectionStatus.DISCONNECTED) {
            UsbConnectButton(onClick = onConnectLocalhost)

            DiscoveredBridgeList(
                bridges = discoveredBridges,
                onConnectToBridge = onConnectToBridge,
            )

            ManualUrlInput(onConnect = onConnectManualUrl)
        }

        if (connectionStatus == ConnectionStatus.CONNECTING) {
            Text(
                text = "Trying to reach bridge...",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
