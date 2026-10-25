package com.devtodo.app.data.update

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SemanticVersionTest {

    @Test
    fun parsesTagsWithPrefixAndPrerelease() {
        val version = SemanticVersion.parse("v2.0.0-rc.53")
        requireNotNull(version)
        assertEquals(2, version.major)
        assertEquals(0, version.minor)
        assertEquals(0, version.patch)
        assertEquals(listOf("rc", "53"), version.preRelease)
        assertTrue(version.isPrerelease)
        assertEquals("2.0.0-rc.53", version.toString())
    }

    @Test
    fun comparesStableAbovePrerelease() {
        val stable = requireNotNull(SemanticVersion.parse("2.0.0"))
        val releaseCandidate = requireNotNull(SemanticVersion.parse("2.0.0-rc.53"))
        assertTrue(stable > releaseCandidate)
        assertTrue(releaseCandidate < stable)
    }

    @Test
    fun comparesPrereleaseNumbersNumerically() {
        val older = requireNotNull(SemanticVersion.parse("2.0.0-rc.2"))
        val newer = requireNotNull(SemanticVersion.parse("2.0.0-rc.10"))
        assertTrue(newer > older)
    }

    @Test
    fun comparesAcrossPatchAndMinorVersions() {
        val current = requireNotNull(SemanticVersion.parse("2.0.0-rc.53"))
        val nextPatch = requireNotNull(SemanticVersion.parse("2.0.1-rc.1"))
        val nextMinor = requireNotNull(SemanticVersion.parse("2.1.0"))
        assertTrue(nextPatch > current)
        assertTrue(nextMinor > nextPatch)
    }

    @Test
    fun rejectsMalformedVersions() {
        assertNull(SemanticVersion.parse(null))
        assertNull(SemanticVersion.parse(""))
        assertNull(SemanticVersion.parse("2.0"))
        assertNull(SemanticVersion.parse("2.0.0-"))
        assertNull(SemanticVersion.parse("02.0.0"))
        assertNull(SemanticVersion.parse("2.0.0-rc.01"))
        assertNull(SemanticVersion.parse("2.0.0-rc..1"))
        assertNull(SemanticVersion.parse("version-2.0.0"))
    }

    @Test
    fun buildMetadataDoesNotChangeUpgradePrecedence() {
        assertEquals(SemanticVersion.parse("2.0.0+one"), SemanticVersion.parse("2.0.0+two"))
    }

    @Test
    fun infersChannelFromInstalledVersion() {
        assertEquals(UpdateChannel.PRERELEASE, updateChannelFor("2.0.0-rc.53"))
        assertEquals(UpdateChannel.STABLE, updateChannelFor("2.0.0"))
        assertEquals(UpdateChannel.STABLE, updateChannelFor(null))
    }
}
