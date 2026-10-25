package com.devtodo.app.data.update

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.util.Properties

internal const val TASKDOCK_UPDATE_FEED =
    "https://raw.githubusercontent.com/IGNGserver/taskdock/updates/updates.json"

private val sha256Pattern = Regex("^[0-9a-fA-F]{64}$")

@Serializable
internal data class GitHubAsset(
    val name: String = "",
    @SerialName("browser_download_url") val downloadUrl: String = "",
    val size: Long = 0,
    val digest: String? = null,
    val state: String = "",
    val versionCode: Long? = null,
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
    val value = digest?.trim()?.takeIf { it.startsWith("sha256:") }?.removePrefix("sha256:").orEmpty()
    return value.takeIf(sha256Pattern::matches)?.lowercase()
}

internal fun isTrustedGitHubUrl(url: String): Boolean {
    val parsed = url.toHttpUrlOrNull() ?: return false
    return parsed.isHttps && parsed.host == "github.com"
}

internal fun isTrustedGitHubAssetHost(host: String): Boolean =
    host == "github.com" || host.endsWith(".githubusercontent.com")

/**
 * Picks the highest strictly-newer release that has an exact Android APK asset.
 * Drafts, older versions and releases for the wrong channel are ignored.
 */
internal fun selectCandidate(
    releases: List<GitHubRelease>,
    currentVersion: SemanticVersion,
    channel: UpdateChannel,
    currentVersionCode: Long = 0,
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
        if (apk.size !in 1..200L * 1024 * 1024 || apk.state != "uploaded" || parseSha256Digest(apk.digest) == null ||
            !apk.downloadUrl.startsWith("https://github.com/IGNGserver/taskdock/releases/download/${release.tagName}/") ||
            (apk.versionCode != null && apk.versionCode <= currentVersionCode)) return@mapNotNull null
        UpdateCandidate(release, version, versionName, apk, prerelease)
    }
    .sortedWith(
        compareByDescending<UpdateCandidate> { it.version }
            .thenBy { it.prerelease },
    )
    .firstOrNull()

@Serializable
internal data class UpdateFeed(
    val schemaVersion: Int,
    val repository: String,
    val generatedAt: String,
    val releases: List<GitHubRelease>,
)

class GitHubReleaseSource(
    private val client: OkHttpClient,
    private val json: Json = Json { ignoreUnknownKeys = true },
    private val releasesUrl: String = TASKDOCK_UPDATE_FEED,
    private val cacheDirectory: File? = null,
    private val clock: () -> Long = System::currentTimeMillis,
    private val jitter: () -> Long = { kotlin.random.Random.nextLong(15 * 60_000L + 1) },
) {
    private val policyFile get() = cacheDirectory?.let { File(it, "policy.properties") }
    private val bodyFile get() = cacheDirectory?.let { File(it, "updates.json") }
    private val etagFile get() = cacheDirectory?.let { File(it, "updates.etag") }
    private var cachedBody: String? = runCatching { bodyFile?.takeIf { it.isFile && it.length() <= MAX_UPDATE_FEED_BYTES }?.inputStream()?.use { readUpdateFeed(it) } }.getOrNull()
    private var etag: String? = runCatching { etagFile?.takeIf { it.isFile && it.length() <= 4096 }?.readText()?.takeIf(String::isNotBlank) }.getOrNull()
    private var policy = loadPolicy()

    suspend fun latestUpdate(
        currentVersion: SemanticVersion,
        channel: UpdateChannel,
        currentVersionCode: Long = 0,
        automatic: Boolean = false,
    ): AndroidUpdate? = withContext(Dispatchers.IO) {
        val candidate = selectCandidate(fetchReleases(automatic), currentVersion, channel, currentVersionCode)
        candidate?.toUpdate(requireNotNull(parseSha256Digest(candidate.apk.digest)))
    }

    /** A channel change only re-evaluates the validated feed; it never evades network cooldowns. */
    internal fun cachedUpdate(current: SemanticVersion, channel: UpdateChannel, code: Long): AndroidUpdate? =
        cachedBody?.let { body -> runCatching {
            selectCandidate(parseReleases(body), current, channel, code)?.let {
                it.toUpdate(requireNotNull(parseSha256Digest(it.apk.digest)))
            }
        }.getOrNull() }

    internal fun parseReleases(body: String): List<GitHubRelease> = try {
        val feed = json.decodeFromString<UpdateFeed>(body)
        require(feed.schemaVersion == 1 && feed.repository == "IGNGserver/taskdock")
        require(validGeneratedAt(feed.generatedAt))
        feed.releases
    } catch (error: Exception) {
        throw UpdateException(UpdateFailure.INVALID_RESPONSE, "更新信息格式异常", error)
    }

    @Synchronized
    private fun fetchReleases(automatic: Boolean): List<GitHubRelease> {
        val now = clock()
        val allowed = policy.allowedAt(automatic)
        if (now < allowed) {
            if (automatic && now >= policy.retryAt) cachedBody?.let { return parseReleases(it) }
            throw UpdateException(UpdateFailure.RATE_LIMITED, "请在 ${(allowed - now + 999) / 1000} 秒后检查更新")
        }
        policy = policy.attempted(now)
        savePolicy()
        try {
            // A missing/corrupt cache must not produce an unusable 304 loop.
            val validCache = cachedBody?.takeIf { runCatching { parseReleases(it) }.isSuccess }
            val request = Request.Builder().url(releasesUrl)
                .header("Accept", "application/json")
                .header("User-Agent", "TaskDock-Android")
                .apply { if (validCache != null) etag?.let { header("If-None-Match", it) } }
                .build()
            return client.newCall(request).execute().use { response ->
                if (response.code != 304 && !response.isSuccessful) {
                    policy = policy.failed(now, response.header("Retry-After"), response.header("X-RateLimit-Reset"))
                    savePolicy()
                    val limited = response.code == 429 || response.code == 403 &&
                        (response.header("Retry-After") != null || response.header("X-RateLimit-Remaining") == "0")
                    throw UpdateException(if (limited) UpdateFailure.RATE_LIMITED else UpdateFailure.NETWORK,
                        if (limited) "更新源暂时限流，请在 ${(policy.retryAt - now + 999) / 1000} 秒后重试" else "检查更新失败（HTTP ${response.code}）")
                }
                val body = if (response.code == 304) validCache
                    ?: throw UpdateException(UpdateFailure.INVALID_RESPONSE, "更新缓存已失效")
                    else response.body?.let { data -> data.byteStream().use { readUpdateFeed(it, data.contentLength()) } }.orEmpty()
                val parsed = parseReleases(body)
                cachedBody = body
                if (response.code != 304) etag = response.header("ETag")
                cacheDirectory?.mkdirs()
                bodyFile?.writeText(body)
                etagFile?.writeText(etag.orEmpty())
                policy = policy.succeeded(now, jitter())
                savePolicy()
                parsed
            }
        } catch (error: Exception) {
            if (policy.failures == 0 || policy.retryAt <= now) {
                policy = policy.failed(now)
                savePolicy()
            }
            if (error is UpdateException) throw error
            throw UpdateException(UpdateFailure.NETWORK, "无法获取仓库更新信息，请检查网络", error)
        }
    }

    private fun loadPolicy(): UpdateFetchPolicy = runCatching {
        val values = Properties()
        policyFile?.takeIf { it.isFile }?.inputStream()?.use(values::load)
        fun value(key: String) = values.getProperty(key)?.toLongOrNull()?.coerceAtLeast(0) ?: 0
        UpdateFetchPolicy(value("attempt"), value("automatic"), value("retry"), value("failures").coerceAtMost(16).toInt())
    }.getOrDefault(UpdateFetchPolicy())

    private fun savePolicy() {
        cacheDirectory?.mkdirs()
        policyFile?.outputStream()?.use { stream ->
            Properties().apply {
                setProperty("attempt", policy.lastAttempt.toString())
                setProperty("automatic", policy.nextAutomatic.toString())
                setProperty("retry", policy.retryAt.toString())
                setProperty("failures", policy.failures.toString())
            }.store(stream, null)
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
    versionCode = apk.versionCode,
)
