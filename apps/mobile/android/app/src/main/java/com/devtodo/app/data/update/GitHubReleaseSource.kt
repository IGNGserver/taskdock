package com.devtodo.app.data.update

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.IOException

internal const val TASKDOCK_RELEASES_API =
    "https://api.github.com/repos/IGNGserver/taskdock/releases?per_page=50"

private val sha256Pattern = Regex("^[0-9a-fA-F]{64}$")

@Serializable
internal data class GitHubAsset(
    val name: String = "",
    @SerialName("browser_download_url") val downloadUrl: String = "",
    val size: Long = 0,
    val digest: String? = null,
)

@Serializable
internal data class GitHubRelease(
    @SerialName("tag_name") val tagName: String = "",
    val body: String? = null,
    @SerialName("html_url") val htmlUrl: String? = null,
    @SerialName("published_at") val publishedAt: String? = null,
    val prerelease: Boolean = false,
    val draft: Boolean = false,
    val assets: List<GitHubAsset> = emptyList(),
)

internal data class UpdateCandidate(
    val release: GitHubRelease,
    val version: SemanticVersion,
    val versionName: String,
    val apk: GitHubAsset,
    val prerelease: Boolean,
)

internal fun androidAssetName(versionName: String): String =
    "TaskDock-$versionName-android.apk"

internal fun parseSha256Digest(digest: String?): String? {
    val value = digest?.substringAfter("sha256:", "")?.trim().orEmpty()
    return value.takeIf(sha256Pattern::matches)?.lowercase()
}

internal fun parseSha256File(contents: String): String? {
    val value = contents.lineSequence()
        .firstOrNull()
        ?.trim()
        ?.split(Regex("\\s+"))
        ?.firstOrNull()
        .orEmpty()
    return value.takeIf(sha256Pattern::matches)?.lowercase()
}

internal fun isTrustedGitHubUrl(url: String): Boolean {
    val parsed = url.toHttpUrlOrNull() ?: return false
    return parsed.isHttps && parsed.host == "github.com"
}

/**
 * Picks the highest strictly-newer release that has an exact Android APK asset.
 * Drafts, older versions and releases for the wrong channel are ignored.
 */
internal fun selectCandidate(
    releases: List<GitHubRelease>,
    currentVersion: SemanticVersion,
    channel: UpdateChannel,
): UpdateCandidate? = releases.asSequence()
    .filterNot { it.draft }
    .mapNotNull { release ->
        val version = SemanticVersion.parse(release.tagName) ?: return@mapNotNull null
        if (version <= currentVersion) return@mapNotNull null
        // The tag is authoritative: an rc/beta/alpha must never reach a stable
        // installation even if the release was accidentally not flagged.
        val prerelease = release.prerelease || version.isPrerelease
        if (channel == UpdateChannel.STABLE && prerelease) return@mapNotNull null
        val versionName = release.tagName.removePrefix("v").removePrefix("V")
        val apk = release.assets.firstOrNull { it.name == androidAssetName(versionName) }
            ?: return@mapNotNull null
        if (apk.size <= 0 || !isTrustedGitHubUrl(apk.downloadUrl)) return@mapNotNull null
        UpdateCandidate(release, version, versionName, apk, prerelease)
    }
    .sortedWith(
        compareByDescending<UpdateCandidate> { it.version }
            .thenBy { it.prerelease },
    )
    .firstOrNull()

class GitHubReleaseSource(
    private val client: OkHttpClient,
    private val json: Json = Json {
        ignoreUnknownKeys = true
        isLenient = true
    },
    private val releasesUrl: String = TASKDOCK_RELEASES_API,
) {
    /**
     * Returns the newest installable update, or null when the installed build is
     * already current for its channel. Throws [UpdateException] on failures.
     */
    suspend fun latestUpdate(
        currentVersion: SemanticVersion,
        channel: UpdateChannel,
    ): AndroidUpdate? = withContext(Dispatchers.IO) {
        val releases = fetchReleases()
        val candidate = selectCandidate(releases, currentVersion, channel)
            ?: return@withContext null
        candidate.toUpdate(resolveSha256(candidate))
    }

    internal fun parseReleases(body: String): List<GitHubRelease> = try {
        json.decodeFromString(body)
    } catch (error: Exception) {
        throw UpdateException(UpdateFailure.INVALID_RESPONSE, "更新信息格式异常", error)
    }

    private fun fetchReleases(): List<GitHubRelease> {
        val request = Request.Builder()
            .url(releasesUrl)
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .header("User-Agent", "TaskDock-Android")
            .get()
            .build()
        return try {
            client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) {
                    if (response.code == 403 || response.code == 429) {
                        throw UpdateException(
                            UpdateFailure.RATE_LIMITED,
                            "GitHub 请求过于频繁，请稍后再试",
                        )
                    }
                    throw UpdateException(
                        UpdateFailure.NETWORK,
                        "检查更新失败（HTTP ${response.code}）",
                    )
                }
                parseReleases(response.body?.string().orEmpty())
            }
        } catch (error: UpdateException) {
            throw error
        } catch (error: IOException) {
            throw UpdateException(UpdateFailure.NETWORK, "无法连接 GitHub，请检查网络", error)
        }
    }

    private fun resolveSha256(candidate: UpdateCandidate): String {
        parseSha256Digest(candidate.apk.digest)?.let { return it }
        val shaAsset = candidate.release.assets.firstOrNull {
            it.name == candidate.apk.name.removeSuffix(".apk") + ".sha256"
        } ?: throw UpdateException(
            UpdateFailure.MISSING_DIGEST,
            "更新包缺少 SHA-256 校验值，已阻止安装",
        )
        val contents = fetchText(shaAsset.downloadUrl)
        return parseSha256File(contents) ?: throw UpdateException(
            UpdateFailure.MISSING_DIGEST,
            "更新包校验文件格式异常，已阻止安装",
        )
    }

    private fun fetchText(url: String): String {
        if (!isTrustedGitHubUrl(url)) {
            throw UpdateException(UpdateFailure.MISSING_DIGEST, "更新包校验地址不受信任")
        }
        val request = Request.Builder()
            .url(url)
            .header("User-Agent", "TaskDock-Android")
            .get()
            .build()
        return try {
            client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) {
                    throw UpdateException(
                        UpdateFailure.NETWORK,
                        "读取更新校验文件失败（HTTP ${response.code}）",
                    )
                }
                response.body?.string().orEmpty()
            }
        } catch (error: UpdateException) {
            throw error
        } catch (error: IOException) {
            throw UpdateException(UpdateFailure.NETWORK, "无法连接 GitHub，请检查网络", error)
        }
    }
}

private fun UpdateCandidate.toUpdate(sha256: String): AndroidUpdate = AndroidUpdate(
    version = versionName,
    tag = release.tagName,
    publishedAt = release.publishedAt,
    notes = release.body?.trim()?.takeIf { it.isNotEmpty() },
    releaseUrl = release.htmlUrl
        ?.takeIf(::isTrustedGitHubUrl)
        ?: "$TASKDOCK_RELEASES_PAGE/tag/${release.tagName}",
    assetName = apk.name,
    assetUrl = apk.downloadUrl,
    assetSize = apk.size,
    sha256 = sha256,
    prerelease = prerelease,
)
