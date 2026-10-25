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
        state = "uploaded",
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
            {"schemaVersion":1,"repository":"IGNGserver/taskdock","generatedAt":"2026-10-25T00:00:00Z","releases":[
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
                    "state":"uploaded",
                    "digest": "sha256:${"a".repeat(64)}"
                  }
                ]
              }
            ]}
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
    fun parsesRequiredSha256Digest() {
        val digest = parseSha256Digest("sha256:" + "A".repeat(64))
        assertEquals("a".repeat(64), digest)
        assertNull(parseSha256Digest("md5:" + "a".repeat(64)))
        assertNull(parseSha256Digest(null))

    }

    @Test
    fun trustsOnlyGitHubHttpsUrls() {
        assertTrue(isTrustedGitHubUrl("https://github.com/IGNGserver/taskdock/releases"))
        assertFalse(isTrustedGitHubUrl("http://github.com/IGNGserver/taskdock/releases"))
        assertFalse(isTrustedGitHubUrl("https://example.com/TaskDock.apk"))
        assertFalse(isTrustedGitHubUrl("not a url"))
        assertTrue(isTrustedGitHubAssetHost("release-assets.githubusercontent.com"))
        assertFalse(isTrustedGitHubAssetHost("github.com.evil.example"))
    }

    @Test
    fun incompleteAndNonIncreasingApksCannotHideAnOlderInstallableUpdate() {
        val current = requireNotNull(SemanticVersion.parse("2.0.0-rc.53"))
        val good = release("v2.0.0-rc.54")
        val missingDigest = release("v2.0.0-rc.60", assets = listOf(asset("v2.0.0-rc.60", digest = null)))
        val lowerCode = release("v2.0.0-rc.61", assets = listOf(asset("v2.0.0-rc.61").copy(versionCode = 10)))
        assertEquals("2.0.0-rc.54", selectCandidate(listOf(good, missingDigest, lowerCode), current,
            UpdateChannel.PRERELEASE, currentVersionCode = 10)?.versionName)
    }

    @Test
    fun rejectsForeignFeedAndMalformedEnvelope() {
        val source = GitHubReleaseSource(OkHttpClient())
        assertThrows(UpdateException::class.java) { source.parseReleases("[]") }
        assertThrows(UpdateException::class.java) {
            source.parseReleases("""{"schemaVersion":1,"repository":"evil/repo","generatedAt":"2026-10-25T00:00:00Z","releases":[]}""")
        }
    }

    @Test
    fun assetNameUsesReleaseVersionWithoutTagPrefix() {
        assertEquals(
            "TaskDock-2.0.0-rc.54-android.apk",
            androidAssetName("2.0.0-rc.54"),
        )
    }
}
