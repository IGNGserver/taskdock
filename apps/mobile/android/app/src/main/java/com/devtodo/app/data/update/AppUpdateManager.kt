package com.devtodo.app.data.update

import android.content.Context
import android.content.pm.ApplicationInfo
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.os.Build
import android.os.StatFs
import androidx.core.content.FileProvider
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import okhttp3.Cache
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

/**
 * Owns the Android in-app update flow:
 * check GitHub Releases -> download to cache -> verify SHA-256 + APK signer ->
 * hand a FileProvider URI to the system package installer.
 *
 * Android does not allow a normal app to install silently. The final
 * confirmation is always the system installer's dialog.
 */
class AppUpdateManager(
    context: Context,
    private val source: GitHubReleaseSource = GitHubReleaseSource(
        createApiClient(context.applicationContext),
        cacheDirectory = File(context.applicationContext.filesDir, "update-feed"),
    ),
    private val downloadClient: OkHttpClient = createDownloadClient(),
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private val appContext = context.applicationContext
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val preferences = appContext.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
    private val updatesDirectory = File(appContext.cacheDir, "updates")
    private val installRequests = MutableSharedFlow<String>(extraBufferCapacity = 1)
    private val installedPackage = readInstalledPackageInfo(appContext)
    private val isDebuggable =
        (appContext.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
    private val currentVersion = installedPackage?.versionName ?: "未知版本"
    @Volatile private var currentChannel = when (preferences.getString("channel", null)) {
        "stable" -> UpdateChannel.STABLE
        "preview" -> UpdateChannel.PRERELEASE
        else -> updateChannelFor(currentVersion).also {
            preferences.edit().putString("channel", if (it == UpdateChannel.STABLE) "stable" else "preview").apply()
        }
    }
    private var activeJob: Job? = null

    private val _state = MutableStateFlow(
        AppUpdateState(
            currentVersion = currentVersion,
            currentChannel = currentChannel,
            lastCheckedAt = preferences.getLong(KEY_LAST_CHECK, 0L).takeIf { it > 0L },
            isDebuggable = isDebuggable,
        ),
    )

    val state: StateFlow<AppUpdateState> = _state.asStateFlow()

    /** One-shot requests to open the system package installer. */
    val installEvents: SharedFlow<String> = installRequests.asSharedFlow()

    init {
        updatesDirectory.mkdirs()
        // A download only needs to survive the current process. Keep a freshly
        // downloaded APK for a day so an installer already holding its URI can
        // still read it, but remove interrupted and stale files eagerly.
        scope.launch { cleanupStaleDownloads() }
    }

    @Synchronized
    fun check(silent: Boolean = false) {
        if (isDebuggable) return
        val snapshot = _state.value
        if (snapshot.checking || snapshot.downloading || activeJob?.isCompleted == false) return
        val current = SemanticVersion.parse(currentVersion) ?: run {
            if (!silent) {
                _state.update {
                    it.copy(error = "无法识别当前版本号：$currentVersion", message = null)
                }
            }
            return
        }
        _state.update { it.copy(checking = true, error = null, message = null) }

        activeJob = scope.launch {
            try {
                source.latestUpdate(current, currentChannel, installedPackage?.longVersionCodeCompat() ?: 0, silent)
                synchronized(this@AppUpdateManager) {
                val update = source.cachedUpdate(current, currentChannel, installedPackage?.longVersionCodeCompat() ?: 0)
                val checkedAt = clock()
                preferences.edit().putLong(KEY_LAST_CHECK, checkedAt).apply()

                val previous = _state.value
                val sameVersion = update != null && previous.update?.version == update.version
                if (!sameVersion) deleteDownloadedFiles()

                _state.update {
                    it.copy(
                        checking = false,
                        update = update,
                        lastCheckedAt = checkedAt,
                        downloadedApkUri = if (sameVersion) it.downloadedApkUri else null,
                        error = null,
                        message = when {
                            update != null -> null
                            !silent -> "当前已是最新版本（v$currentVersion）"
                            else -> null
                        },
                    )
                }
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: UpdateException) {
                if (silent) {
                    _state.update { it.copy(checking = false) }
                } else if (_state.value.update == null) {
                    _state.update {
                        it.copy(
                            checking = false,
                            error = error.message,
                            message = null,
                        )
                    }
                } else {
                    _state.update {
                        it.copy(
                            checking = false,
                            message = "检查失败：${error.message}",
                        )
                    }
                }
            } catch (error: Exception) {
                if (silent) {
                    _state.update { it.copy(checking = false) }
                } else {
                    _state.update {
                        it.copy(
                            checking = false,
                            error = "检查更新失败，请稍后重试",
                            message = null,
                        )
                    }
                }
            }
        }
    }

    @Synchronized
    fun setUpdateChannel(channel: UpdateChannel) {
        if (currentChannel == channel) return
        currentChannel = channel
        if (_state.value.downloading) activeJob?.cancel()
        preferences.edit().putString("channel", if (channel == UpdateChannel.STABLE) "stable" else "preview").apply()
        deleteDownloadedFiles()
        val update = SemanticVersion.parse(currentVersion)?.let {
            source.cachedUpdate(it, channel, installedPackage?.longVersionCodeCompat() ?: 0)
        }
        _state.update { it.copy(currentChannel = channel, update = update, downloading = false, downloadedApkUri = null,
            error = null, message = "更新通道已保存，仅提示更高版本") }
    }
    @Synchronized
    fun download() {
        if (isDebuggable) return
        val snapshot = _state.value
        val update = snapshot.update?.takeIf { updateAllowed(it, currentVersion, currentChannel) } ?: return
        if (snapshot.checking || snapshot.downloading || activeJob?.isCompleted == false) return

        _state.update { it.copy(downloading = true) }
        activeJob = scope.launch {
            _state.update {
                it.copy(
                    downloading = true,
                    progress = 0f,
                    downloadedBytes = 0L,
                    totalBytes = update.assetSize,
                    downloadedApkUri = null,
                    error = null,
                    message = null,
                )
            }
            val target = File(updatesDirectory, update.assetName)
            val partial = File(updatesDirectory, "${update.assetName}.part")
            try {
                deleteDownloadedFiles()
                ensureAvailableSpace(update.assetSize)
                val actualSha256 = downloadTo(update, partial)
                if (!actualSha256.equals(update.sha256, ignoreCase = true)) {
                    throw UpdateException(
                        UpdateFailure.HASH_MISMATCH,
                        "更新包校验失败，已删除",
                    )
                }
                if (update.assetSize > 0L && partial.length() != update.assetSize) {
                    throw UpdateException(
                        UpdateFailure.HASH_MISMATCH,
                        "更新包大小不一致，已删除",
                    )
                }
                verifyApk(partial, update)
                if (!partial.renameTo(target)) {
                    throw UpdateException(UpdateFailure.UNKNOWN, "无法保存更新包，请重试")
                }
                val uri = FileProvider.getUriForFile(
                    appContext,
                    "${appContext.packageName}.fileprovider",
                    target,
                ).toString()
                synchronized(this@AppUpdateManager) {
                if (!updateAllowed(update, currentVersion, currentChannel)) {
                    throw UpdateException(UpdateFailure.INVALID_APK, "当前通道已变更，请重新检查更新")
                }
                _state.update {
                    it.copy(
                        downloading = false,
                        progress = 1f,
                        downloadedBytes = target.length(),
                        totalBytes = target.length(),
                        downloadedApkUri = uri,
                        error = null,
                        message = "更新包已下载并通过校验",
                    )
                }
                installRequests.tryEmit(uri)
                }
            } catch (cancelled: CancellationException) {
                partial.delete()
                target.delete()
                _state.update {
                    it.copy(
                        downloading = false,
                        progress = 0f,
                        downloadedBytes = 0L,
                        downloadedApkUri = null,
                        message = "已取消下载",
                    )
                }
                throw cancelled
            } catch (error: UpdateException) {
                partial.delete()
                target.delete()
                _state.update {
                    it.copy(
                        downloading = false,
                        progress = 0f,
                        downloadedBytes = 0L,
                        downloadedApkUri = null,
                        error = error.message,
                        message = null,
                    )
                }
            } catch (error: Exception) {
                partial.delete()
                target.delete()
                _state.update {
                    it.copy(
                        downloading = false,
                        progress = 0f,
                        downloadedBytes = 0L,
                        downloadedApkUri = null,
                        error = "下载更新失败，请稍后重试",
                        message = null,
                    )
                }
            }
        }
    }

    fun cancelDownload() {
        if (!_state.value.downloading) return
        activeJob?.cancel(CancellationException("用户取消更新下载"))
    }

    fun requestInstall() {
        val snapshot = _state.value
        val update = snapshot.update ?: return
        if (!updateAllowed(update, currentVersion, currentChannel)) return
        snapshot.downloadedApkUri?.let { installRequests.tryEmit(it) }
    }

    fun close() {
        activeJob?.cancel()
        scope.cancel()
    }

    private suspend fun downloadTo(update: AndroidUpdate, target: File): String {
        val request = Request.Builder()
            .url(update.assetUrl)
            .header("User-Agent", "TaskDock-Android")
            .get()
            .build()
        return try {
            downloadClient.newCall(request).execute().use { response ->
                if (!response.isSuccessful) {
                    throw UpdateException(
                        UpdateFailure.NETWORK,
                        "下载更新失败（HTTP ${response.code}）",
                    )
                }
                if (!response.request.url.isHttps) {
                    throw UpdateException(UpdateFailure.NETWORK, "更新包下载地址不安全")
                }
                val body = response.body
                    ?: throw UpdateException(UpdateFailure.NETWORK, "更新包响应为空")
                val total = body.contentLength().takeIf { it > 0L } ?: update.assetSize
                _state.update {
                    it.copy(totalBytes = total, progress = 0f, downloadedBytes = 0L)
                }

                val digest = MessageDigest.getInstance("SHA-256")
                var copied = 0L
                FileOutputStream(target).use { output ->
                    body.byteStream().use { input ->
                        val buffer = ByteArray(BUFFER_SIZE)
                        while (true) {
                            currentCoroutineContext().ensureActive()
                            val count = input.read(buffer)
                            if (count < 0) break
                            output.write(buffer, 0, count)
                            digest.update(buffer, 0, count)
                            copied += count
                            if (copied > MAX_APK_BYTES) {
                                throw UpdateException(
                                    UpdateFailure.INVALID_APK,
                                    "更新包超过允许的大小",
                                )
                            }
                            _state.update {
                                it.copy(
                                    progress = if (total > 0L) {
                                        (copied.toFloat() / total).coerceIn(0f, 1f)
                                    } else {
                                        0f
                                    },
                                    downloadedBytes = copied,
                                )
                            }
                        }
                    }
                    output.fd.sync()
                }
                if (copied != update.assetSize) {
                    throw UpdateException(UpdateFailure.INVALID_APK, "更新包大小与发布信息不一致")
                }
                digest.digest().toHex()
            }
        } catch (error: UpdateException) {
            throw error
        } catch (error: IOException) {
            throw UpdateException(UpdateFailure.NETWORK, "下载更新失败，请检查网络", error)
        }
    }

    private fun verifyApk(file: File, update: AndroidUpdate) {
        if (!updateAllowed(update, currentVersion, currentChannel)) {
            throw UpdateException(UpdateFailure.INVALID_APK, "当前通道已变更，请重新检查更新")
        }
        val packageManager = appContext.packageManager
        val archive = readPackageArchiveInfo(packageManager, file.absolutePath)
            ?: throw UpdateException(UpdateFailure.INVALID_APK, "更新包无法解析，已删除")
        if (archive.packageName != appContext.packageName) {
            throw UpdateException(
                UpdateFailure.INVALID_APK,
                "更新包应用标识不匹配，已阻止安装",
            )
        }
        if (archive.versionName != update.version) {
            throw UpdateException(
                UpdateFailure.INVALID_APK,
                "更新包版本与发布信息不一致，已阻止安装",
            )
        }
        val current = installedPackage
            ?: throw UpdateException(UpdateFailure.INVALID_APK, "无法读取当前应用版本")
        if (archive.longVersionCodeCompat() <= current.longVersionCodeCompat() ||
            (update.versionCode != null && archive.longVersionCodeCompat() != update.versionCode)) {
            throw UpdateException(
                UpdateFailure.INVALID_APK,
                "更新包版本号低于当前应用，已阻止安装",
            )
        }
        val archiveSigners = archive.signerDigests()
        val currentSigners = current.signerDigests()
        if (archiveSigners.isEmpty() || archiveSigners != currentSigners) {
            throw UpdateException(
                UpdateFailure.SIGNATURE_MISMATCH,
                "更新包签名与当前应用不一致，已阻止安装",
            )
        }
    }

    private fun ensureAvailableSpace(required: Long) {
        val available = StatFs(updatesDirectory.absolutePath).availableBytes
        val margin = 8L * 1024 * 1024
        if (available < required + margin) {
            throw UpdateException(UpdateFailure.NO_SPACE, "存储空间不足，无法下载更新")
        }
    }

    private fun deleteDownloadedFiles() {
        updatesDirectory.listFiles()?.forEach { file -> file.delete() }
    }

    private fun cleanupStaleDownloads() {
        val now = clock()
        val apkCutoff = now - STALE_DOWNLOAD_MS
        val partCutoff = now - STALE_PART_MS
        updatesDirectory.listFiles()?.forEach { file ->
            if (file.name.endsWith(".part")) {
                if (file.lastModified() < partCutoff) file.delete()
            } else if (file.lastModified() < apkCutoff) {
                file.delete()
            }
        }
    }

    private fun PackageInfo.longVersionCodeCompat(): Long =
        if (Build.VERSION.SDK_INT >= 28) {
            longVersionCode
        } else {
            @Suppress("DEPRECATION")
            versionCode.toLong()
        }

    private fun PackageInfo.signerDigests(): Set<String> {
        val certificates = if (Build.VERSION.SDK_INT >= 28) {
            signingInfo?.apkContentsSigners
        } else {
            @Suppress("DEPRECATION")
            signatures
        } ?: return emptySet()
        return certificates.mapTo(linkedSetOf()) { certificate ->
            sha256(certificate.toByteArray())
        }
    }

    private companion object {
        const val PREFERENCES_NAME = "taskdock_app_update"
        const val KEY_LAST_CHECK = "last_check_at"
        const val STALE_DOWNLOAD_MS = 24L * 60L * 60L * 1000L
        const val STALE_PART_MS = 60L * 60L * 1000L
        const val BUFFER_SIZE = 128 * 1024
        const val MAX_APK_BYTES = 200L * 1024L * 1024L
    }
}

private fun packageInfoFlags(): Int =
    if (Build.VERSION.SDK_INT >= 28) {
        PackageManager.GET_SIGNING_CERTIFICATES
    } else {
        @Suppress("DEPRECATION")
        PackageManager.GET_SIGNATURES
    }

private fun readInstalledPackageInfo(context: Context): PackageInfo? = runCatching {
    val manager = context.packageManager
    val flags = packageInfoFlags()
    if (Build.VERSION.SDK_INT >= 33) {
        manager.getPackageInfo(
            context.packageName,
            PackageManager.PackageInfoFlags.of(flags.toLong()),
        )
    } else {
        @Suppress("DEPRECATION")
        manager.getPackageInfo(context.packageName, flags)
    }
}.getOrNull()

private fun readPackageArchiveInfo(manager: PackageManager, path: String): PackageInfo? {
    val flags = packageInfoFlags()
    return if (Build.VERSION.SDK_INT >= 33) {
        manager.getPackageArchiveInfo(
            path,
            PackageManager.PackageInfoFlags.of(flags.toLong()),
        )
    } else {
        @Suppress("DEPRECATION")
        manager.getPackageArchiveInfo(path, flags)
    }
}

private fun createApiClient(context: Context): OkHttpClient {
    val cache = Cache(File(context.cacheDir, "github_api_cache"), 4L * 1024L * 1024L)
    return OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .callTimeout(30, TimeUnit.SECONDS)
        .cache(cache)
        .build()
}

private fun createDownloadClient(): OkHttpClient = OkHttpClient.Builder()
    .addNetworkInterceptor { chain ->
        val url = chain.request().url
        if (!url.isHttps || !isTrustedGitHubAssetHost(url.host)) {
            throw IOException("更新包下载地址不受信任")
        }
        chain.proceed(chain.request())
    }
    .connectTimeout(15, TimeUnit.SECONDS)
    .readTimeout(60, TimeUnit.SECONDS)
    .callTimeout(0, TimeUnit.SECONDS)
    .build()

private fun sha256(bytes: ByteArray): String =
    MessageDigest.getInstance("SHA-256").digest(bytes).toHex()

private fun ByteArray.toHex(): String = joinToString("") { byte -> "%02x".format(byte) }
