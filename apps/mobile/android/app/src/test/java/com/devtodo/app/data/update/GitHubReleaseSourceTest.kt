package com.devtodo.app.data.update

import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class GitHubReleaseSourceTest {

    private fun asset(
        tag: String,
        name: String = androidAssetName(tag.removePrefix("v")),
        url: String = "https://github.com/IGNGserver/taskdock/releases/download/$tag/$name",
        size: Long = 1024L,
        digest: String? = "sha256:" + "a".repeat(64),
    ) = GitHubAsset(
        name = name,
        downloadUrl = url,
        size = size,
        digest = digest,
    )

    private fun release(
        tag: String,
        prerelease: Boolean = false,
        draft: Boolean = false,
        assets: List<GitHubAsset> = listOf(asset(tag)),
    ) = GitHubRelease(
        tagName = tag,
        prerelease = prerelease,
        draft = draft,
        assets = assets,
    )

    @Test
    fun stableChannelIgnoresPrerelease() {
        val current = requireNotNull(SemanticVersion.parse("2.0.0-rc.53"))
        val candidate = selectCandidate(
            releases = listOf(release("v2.0.0-rc.54", prerelease = true)),
            currentVersion = current,
            channel = UpdateChannel.STABLE,
        )
        assertNull(candidate)
    }

    @Test
    fun stableChannelIgnoresRcTagEvenWhenReleaseFlagIsMissing() {
        val current = requireNotNull(SemanticVersion.parse("2.0.0-rc.53"))
        val candidate = selectCandidate(
            releases = listOf(release("v2.0.0-rc.54", prerelease = false)),
            currentVersion = current,
            channel = UpdateChannel.STABLE,
        )
        assertNull(candidate)
    }

    @Test
    fun prereleaseChannelSelectsNewestReleaseCandidate() {
        val current = requireNotNull(SemanticVersion.parse("2.0.0-rc.53"))
        val candidate = selectCandidate(
            releases = listOf(
                release("v2.0.0-rc.54", prerelease = true),
                release("v2.0.0-rc.55", prerelease = true),
            ),
            currentVersion = current,
            channel = UpdateChannel.PRERELEASE,
        )
        requireNotNull(candidate)
        assertEquals("2.0.0-rc.55", candidate.versionName)
        assertEquals("TaskDock-2.0.0-rc.55-android.apk", candidate.apk.name)
    }

    @Test
    fun prereleaseBuildGraduatesToStableRelease() {
        val current = requireNotNull(SemanticVersion.parse("2.0.0-rc.53"))
        val candidate = selectCandidate(
            releases = listOf(
                release("v2.0.0-rc.54", prerelease = true),
                release("v2.0.0"),
            ),
            currentVersion = current,
            channel = UpdateChannel.PRERELEASE,
        )
        requireNotNull(candidate)
        assertEquals("2.0.0", candidate.versionName)
        assertFalse(candidate.release.prerelease)
    }

    @Test
    fun ignoresDraftOlderAndMissingApkReleases() {
        val current = requireNotNull(SemanticVersion.parse("2.0.0-rc.53"))
        val candidate = selectCandidate(
            releases = listOf(
                release("v2.0.0-rc.60", prerelease = true, draft = true),
                release("v2.0.0-rc.53", prerelease = true),
                release(
                    "v2.0.0-rc.54",
                    prerelease = true,
                    assets = listOf(asset("v2.0.0-rc.54", name = "TaskDock-2.0.0-rc.54-linux-x64.tar.gz")),
                ),
            ),
            currentVersion = current,
            channel = UpdateChannel.PRERELEASE,
        )
        assertNull(candidate)
    }

    @Test
    fun requiresExactAndroidAssetAndTrustedHttpsUrl() {
        val current = requireNotNull(SemanticVersion.parse("2.0.0-rc.53"))
        val untrusted = selectCandidate(
            releases = listOf(
                release(
                    "v2.0.0-rc.54",
                    prerelease = true,
                    assets = listOf(
                        asset(
                            "v2.0.0-rc.54",
                            url = "https://example.com/TaskDock-2.0.0-rc.54-android.apk",
                        ),
                    ),
                ),
            ),
            currentVersion = current,
            channel = UpdateChannel.PRERELEASE,
        )
        assertNull(untrusted)
    }

    @Test
    fun parsesReleaseJson() {
        val source = GitHubReleaseSource(OkHttpClient())
        val parsed = source.parseReleases(
            """
            [
              {
                "tag_name": "v2.0.0-rc.54",
                "html_url": "https://github.com/IGNGserver/taskdock/releases/tag/v2.0.0-rc.54",
                "published_at": "2026-10-22T08:00:00Z",
                "prerelease": true,
                "draft": false,
                "assets": [
                  {
                    "name": "TaskDock-2.0.0-rc.54-android.apk",
                    "browser_download_url": "https://github.com/IGNGserver/taskdock/releases/download/v2.0.0-rc.54/TaskDock-2.0.0-rc.54-android.apk",
                    "size": 24450967,
                    "digest": "sha256:${"a".repeat(64)}"
                  }
                ]
              }
            ]
            """.trimIndent(),
        )
        assertEquals(1, parsed.size)
        assertEquals("v2.0.0-rc.54", parsed.single().tagName)
        assertEquals("TaskDock-2.0.0-rc.54-android.apk", parsed.single().assets.single().name)
        assertThrows(UpdateException::class.java) {
            source.parseReleases("not-json")
        }
    }

    @Test
    fun parsesSha256FromDigestOrChecksumFile() {
        val digest = parseSha256Digest("sha256:" + "A".repeat(64))
        assertEquals("a".repeat(64), digest)
        assertNull(parseSha256Digest("md5:" + "a".repeat(64)))
        assertNull(parseSha256Digest(null))

        val file = parseSha256File("${"b".repeat(64)}  TaskDock-2.0.0-rc.54-android.apk\n")
        assertEquals("b".repeat(64), file)
        assertNull(parseSha256File("not a checksum"))
    }

    @Test
    fun trustsOnlyGitHubHttpsUrls() {
        assertTrue(isTrustedGitHubUrl("https://github.com/IGNGserver/taskdock/releases"))
        assertFalse(isTrustedGitHubUrl("http://github.com/IGNGserver/taskdock/releases"))
        assertFalse(isTrustedGitHubUrl("https://example.com/TaskDock.apk"))
        assertFalse(isTrustedGitHubUrl("not a url"))
    }

    @Test
    fun assetNameUsesReleaseVersionWithoutTagPrefix() {
        assertEquals(
            "TaskDock-2.0.0-rc.54-android.apk",
            androidAssetName("2.0.0-rc.54"),
        )
    }
}
