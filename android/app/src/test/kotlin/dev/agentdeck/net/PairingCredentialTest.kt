package dev.agentdeck.net

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A discovered endpoint must not un-pair a device.
 *
 * Case-for-case mirror of Apple's `PairingCredentialTests`. Keep the two in
 * step: they encode one cross-platform contract, not two implementations.
 */
class PairingCredentialTest {

    private val paired = "ws://192.168.1.10:9120?token=abcdef0123456789abcdef0123456789"
    private val discovered = "ws://192.168.1.10:9120"

    @Test
    fun `credential is not part of a daemon's identity`() {
        assertTrue(PairingCredential.sameEndpoint(discovered, paired))
    }

    @Test
    fun `default port matches an explicit default port`() {
        assertTrue(PairingCredential.sameEndpoint("ws://192.168.1.10", "ws://192.168.1.10:9120"))
    }

    @Test
    fun `different host or port are different daemons`() {
        assertFalse(PairingCredential.sameEndpoint(discovered, "ws://192.168.1.11:9120"))
        assertFalse(PairingCredential.sameEndpoint(discovered, "ws://192.168.1.10:9125"))
    }

    @Test
    fun `unparseable inputs never compare equal`() {
        assertFalse(PairingCredential.sameEndpoint(null, null))
        assertFalse(PairingCredential.sameEndpoint(discovered, null))
        assertFalse(PairingCredential.sameEndpoint("not a url", "not a url"))
    }

    @Test
    fun `token extraction treats empty as absent`() {
        assertEquals("abcdef0123456789abcdef0123456789", PairingCredential.tokenIn(paired))
        assertNull(PairingCredential.tokenIn(discovered))
        assertNull(PairingCredential.tokenIn("ws://192.168.1.10:9120?token="))
        assertNull(PairingCredential.tokenIn(null))
    }

    @Test
    fun `paired endpoint inherits its stored credential`() {
        assertEquals(paired, PairingCredential.resolve(discovered, paired))
    }

    @Test
    fun `a different daemon never inherits another endpoint's credential`() {
        val other = "ws://192.168.1.11:9120"
        assertEquals(other, PairingCredential.resolve(other, paired))
    }

    @Test
    fun `no stored credential leaves the discovered url untouched`() {
        assertEquals(discovered, PairingCredential.resolve(discovered, null))
        assertEquals(discovered, PairingCredential.resolve(discovered, discovered))
    }

    @Test
    fun `an explicitly credentialed discovery wins`() {
        val legacy = "ws://192.168.1.10:9120?token=1111111111111111"
        assertEquals(legacy, PairingCredential.resolve(legacy, paired))
    }

    // --- persistence guard: the racy-overwrite half of the regression ---

    @Test
    fun `a tokenless url may not displace a stored credential for the same daemon`() {
        assertFalse(PairingCredential.mayPersist(discovered, paired))
    }

    @Test
    fun `a credentialed url always persists`() {
        assertTrue(PairingCredential.mayPersist(paired, discovered))
        assertTrue(PairingCredential.mayPersist(paired, null))
    }

    @Test
    fun `a tokenless url persists when nothing better is stored`() {
        assertTrue(PairingCredential.mayPersist(discovered, null))
        assertTrue(PairingCredential.mayPersist(discovered, discovered))
    }

    @Test
    fun `a tokenless url for a different daemon still persists`() {
        assertTrue(PairingCredential.mayPersist("ws://192.168.1.11:9120", paired))
    }

    @Test
    fun `localhost and blank are never persisted`() {
        assertFalse(PairingCredential.mayPersist(null, null))
        assertFalse(PairingCredential.mayPersist("", null))
        assertFalse(PairingCredential.mayPersist("ws://127.0.0.1:9120", null))
        assertFalse(PairingCredential.mayPersist("ws://localhost:9120", null))
    }
}
