package com.devtodo.app.ui.screens

import org.junit.Assert.*
import org.junit.Test

class HubOriginTest {
    @Test
    fun acceptsTrustedHttpAndNormalizesOrigin() {
        assertEquals(
            "http://192.168.1.20:48731",
            normalizedHubOrigin("  http://192.168.1.20:48731/  "),
        )
        assertEquals("https://example.com", normalizedHubOrigin("https://EXAMPLE.com:443/"))
    }

    @Test
    fun rejectsCredentialsPathsAndNonHttpSchemes() {
        listOf(
                "example.com",
                "file:///tmp/hub",
                "https://user:password@example.com",
                "https://example.com/api",
                "https://example.com?token=123",
                "https://example.com/#fragment",
            )
            .forEach { assertNull(it, normalizedHubOrigin(it)) }
    }
}
