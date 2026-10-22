package com.devtodo.app.data.update

/** The channel an installed build belongs to. Prerelease builds may graduate to stable. */
enum class UpdateChannel {
    STABLE,
    PRERELEASE,
}

/** A verified candidate from the public GitHub Releases feed. */
data class AndroidUpdate(
    val version: String,
    val tag: String,
    val publishedAt: String?,
    val notes: String?,
    val releaseUrl: String,
    val assetName: String,
    val assetUrl: String,
    val assetSize: Long,
    val sha256: String,
    val prerelease: Boolean,
)

/** Everything the settings screen needs to render the update section. */
data class AppUpdateState(
    val currentVersion: String,
    val currentChannel: UpdateChannel,
    val checking: Boolean = false,
    val downloading: Boolean = false,
    val progress: Float = 0f,
    val downloadedBytes: Long = 0L,
    val totalBytes: Long = 0L,
    val update: AndroidUpdate? = null,
    /** FileProvider URI of a downloaded, hash- and signature-verified APK. */
    val downloadedApkUri: String? = null,
    val error: String? = null,
    val message: String? = null,
    val lastCheckedAt: Long? = null,
    val isDebuggable: Boolean = false,
)

internal enum class UpdateFailure {
    NETWORK,
    RATE_LIMITED,
    INVALID_RESPONSE,
    MISSING_DIGEST,
    NO_SPACE,
    HASH_MISMATCH,
    INVALID_APK,
    SIGNATURE_MISMATCH,
    UNKNOWN,
}

internal class UpdateException(
    val failure: UpdateFailure,
    message: String,
    cause: Throwable? = null,
) : Exception(message, cause)

const val TASKDOCK_RELEASES_PAGE = "https://github.com/IGNGserver/taskdock/releases"

internal fun updateChannelFor(version: String?): UpdateChannel =
    if (version != null && SemanticVersion.parse(version)?.isPrerelease == true) {
        UpdateChannel.PRERELEASE
    } else {
        UpdateChannel.STABLE
    }
