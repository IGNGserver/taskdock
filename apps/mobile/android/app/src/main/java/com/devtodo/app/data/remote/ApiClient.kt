package com.devtodo.app.data.remote

import android.util.Base64
import com.devtodo.app.data.model.*
import com.devtodo.app.data.security.SecureAuthManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.withContext
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.asContextElement
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.ResponseBody.Companion.toResponseBody
import java.io.IOException
import java.security.SecureRandom
import java.util.concurrent.TimeUnit
import java.util.concurrent.ConcurrentHashMap

enum class ApiFailureCategory {
    AUTH_REQUIRED,
    INCOMPATIBLE,
    SERVER_UNAVAILABLE,
    REQUEST_REJECTED,
    /** The pull cursor fell outside the server's retention window. */
    CURSOR_EXPIRED
}

class ApiClientException(
    val statusCode: Int,
    val errorCode: String?,
    val category: ApiFailureCategory,
    val serverMessage: String,
) : IOException("${category.name}: ${errorCode ?: "HTTP_$statusCode"}: $serverMessage")

class ApiClient(private val authManager: SecureAuthManager) {
    private data class SessionRequest(val key: String, val token: String?, val origin: String)
    private val requestSession = ThreadLocal<SessionRequest>()
    private suspend fun <T> inSession(block: suspend CoroutineScope.() -> T): T {
        val binding = SessionRequest(authManager.sessionKey, authManager.accessToken, authManager.hubOrigin)
        return withContext(Dispatchers.IO + requestSession.asContextElement(binding), block)
    }
    private val activeCalls = ConcurrentHashMap<Call, String>()
    private val networkQuality = NetworkQuality()
    val isConstrainedNetwork: Boolean get() = networkQuality.constrained
    fun cancelSessionCalls(session: String) {
        activeCalls.forEach { (call, key) -> if (key == session) call.cancel() }
    }
    private suspend fun Call.awaitResponse(): Response {
        activeCalls[this] = request().tag(SessionRequest::class.java)?.key ?: authManager.sessionKey
        return awaitBufferedResponse(
            finished = { activeCalls.remove(this) },
            measured = networkQuality::record,
        )
    }
    private fun Call.executeTracked(): Response {
        activeCalls[this] = requestSession.get()?.key ?: authManager.sessionKey
        return try {
            execute().use { response ->
                val body = response.body
                val type = body?.contentType()
                val bytes = body?.bytes() ?: ByteArray(0)
                response.newBuilder().body(bytes.toResponseBody(type)).build()
            }
        } finally { activeCalls.remove(this) }
    }
    val json = Json {
        ignoreUnknownKeys = true
        isLenient = true
        encodeDefaults = true
    }

    private val jsonMediaType = "application/json; charset=utf-8".toMediaType()
    private val refreshLock = Any()
    private val secureRandom = SecureRandom()
    private val nativeOrigin = "https://localhost"

    /**
     * The raw client is intentionally kept free of the bearer interceptor and
     * authenticator. Refreshing through the same client would recurse when a
     * revoked refresh token also returns 401.
     */
    private val rawHttpClient = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .callTimeout(45, TimeUnit.SECONDS)
        .pingInterval(20, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .addInterceptor { chain ->
            val builder = chain.request().newBuilder()
                .header("X-Client-Platform", "android")
            chain.proceed(builder.build())
        }
        .build()

    private val okHttpClient = rawHttpClient.newBuilder()
        .addInterceptor { chain ->
            val original = chain.request()
            val builder = original.newBuilder()
                .header("Accept", "application/json")
                .header("X-Client-Id", authManager.clientId)
                .header("X-Client-Platform", "android")
            val binding = original.tag(SessionRequest::class.java)
            if (binding != null && binding.key != authManager.sessionKey) throw IOException("请求账户或中枢已变化")
            val publicRoute = original.url.encodedPath in setOf("/api/v1/bootstrap/status", "/api/v1/auth/login")
            binding?.token?.takeIf { !publicRoute }?.let { token ->
                builder.header("Authorization", "Bearer $token")
            }
            chain.proceed(builder.build())
        }
        .authenticator { _, response -> authenticate(response) }
        .build()

    private fun baseUrl(): String = "${requestSession.get()?.origin ?: authManager.hubOrigin}/api/v1"
    private fun baseUrlV2(): String = "${requestSession.get()?.origin ?: authManager.hubOrigin}/api/v2"
    private fun authenticatedCall(request: Request): Call = okHttpClient.newCall(request.newBuilder()
        .tag(SessionRequest::class.java, requestSession.get() ?: SessionRequest(authManager.sessionKey, authManager.accessToken, authManager.hubOrigin)).build())

    suspend fun checkHubStatus(origin: String): Result<HubStatusResponse> = inSession {
        try {
            val req = Request.Builder()
                .url("${origin.trimEnd('/')}/api/v1/bootstrap/status")
                .get()
                .build()
            authenticatedCall(req).awaitResponse().use { resp ->
                val bodyStr = resp.body?.string() ?: ""
                if (resp.isSuccessful) {
                    val status = json.decodeFromString<HubStatusResponse>(bodyStr)
                    Result.success(status)
                } else {
                    Result.failure(apiFailure("hub status", resp, bodyStr))
                }
            }
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    suspend fun login(username: String, password: String): Result<LoginResponse> = inSession {
        try {
            val session = authManager.sessionKey
            val challenge = requestNativeChallenge()
                ?: return@inSession Result.failure(IOException("Native auth challenge failed"))
            val payload = json.encodeToString(
                mapOf(
                    "username" to username,
                    "password" to password,
                    "deviceName" to "Android",
                    "platform" to "android",
                    "nativeChallenge" to challenge
                )
            )
            val req = Request.Builder()
                .url("${baseUrl()}/auth/login")
                .header("Origin", nativeOrigin)
                .post(payload.toRequestBody(jsonMediaType))
                .build()
            authenticatedCall(req).awaitResponse().use { resp ->
                val bodyStr = resp.body?.string() ?: ""
                if (resp.isSuccessful) {
                    if (session != authManager.sessionKey) return@use Result.failure(IOException("登录请求已失效"))
                    val loginRes = json.decodeFromString<LoginResponse>(bodyStr)
                    val refreshToken = loginRes.refreshToken
                        ?: return@use Result.failure(IOException("Login response missing refresh token"))
                    authManager.advanceSession()
                    authManager.setSessionTokens(loginRes.accessToken, refreshToken)
                    authManager.ownerId = loginRes.user.id
                    authManager.username = loginRes.user.username
                    loginRes.hubId?.let(authManager::rememberHubIdentity)
                    Result.success(loginRes)
                } else {
                    Result.failure(apiFailure("login", resp, bodyStr))
                }
            }
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    /** Restore the short-lived access token from the encrypted native session. */
    fun restoreSession(): Boolean {
        if (authManager.hasUsableAccessToken) return true
        return refreshSession(authManager.accessToken)
    }

    private fun authenticate(response: Response): Request? {
        if (response.request.tag(SessionRequest::class.java)?.key != authManager.sessionKey) return null
        val authorization = response.request.header("Authorization") ?: return null
        if (responseCount(response) > 1) return null
        val failedAccessToken = authorization.removePrefix("Bearer ")
        val currentAccessToken = authManager.accessToken
        if (!currentAccessToken.isNullOrBlank() && currentAccessToken != failedAccessToken) {
            return response.request.newBuilder()
                .header("Authorization", "Bearer $currentAccessToken")
                .build()
        }
        if (!refreshSession(failedAccessToken)) return null
        if (response.request.tag(SessionRequest::class.java)?.key != authManager.sessionKey) return null
        val nextAccessToken = authManager.accessToken ?: return null
        return response.request.newBuilder()
            .header("Authorization", "Bearer $nextAccessToken")
            .build()
    }

    private fun refreshSession(failedAccessToken: String?): Boolean {
        synchronized(refreshLock) {
            val session = authManager.sessionKey
            val origin = authManager.hubOrigin
            val currentAccessToken = authManager.accessToken
            if (
                failedAccessToken != null &&
                !currentAccessToken.isNullOrBlank() &&
                currentAccessToken != failedAccessToken
            ) {
                return true
            }
            val refreshToken = authManager.refreshToken ?: return false
            // The replacement secret is generated and committed here, before the
            // request. If the reply is lost the retry offers the same pair, so the
            // Hub can resume the rotation instead of revoking the session chain.
            val candidate = authManager.pendingRefreshToken
                ?: newRefreshCandidate().also { authManager.pendingRefreshToken = it }
            val challenge = try {
                requestNativeChallenge(origin)
            } catch (_: ApiClientException) {
                // Session restoration is best-effort. Keep local data usable
                // when the challenge service rejects or cannot serve a request.
                return false
            } ?: return false
            if (session != authManager.sessionKey) return false
            val payload = json.encodeToString(
                mapOf(
                    "refreshToken" to refreshToken,
                    "nextRefreshToken" to candidate,
                    "nativeChallenge" to challenge
                )
            )
            val request = Request.Builder()
                .url("$origin/api/v1/auth/refresh")
                .header("Origin", nativeOrigin)
                .header("X-Client-Id", authManager.clientId)
                .post(payload.toRequestBody(jsonMediaType))
                .build()
            return try {
                rawHttpClient.newCall(request).executeTracked().use { response ->
                    val body = response.body?.string() ?: ""
                    if (session != authManager.sessionKey) return@use false
                    if (!response.isSuccessful) {
                        if (isSessionRevocation(response.code, body)) authManager.clearSession()
                        false
                    } else {
                        val result = json.decodeFromString<LoginResponse>(body)
                        val nextRefreshToken = result.refreshToken
                            ?.takeIf { it.isNotBlank() }
                            ?: candidate
                        authManager.setSessionTokens(result.accessToken, nextRefreshToken)
                        authManager.ownerId = result.user.id
                        authManager.username = result.user.username
                        result.hubId?.let(authManager::rememberHubIdentity)
                        true
                    }
                }
            } catch (_: IOException) {
                false
            } catch (_: Exception) {
                false
            }
        }
    }

    /**
     * True only when the Hub named this device's session as the problem. A 401
     * caused by anything else must leave the stored credential intact so the
     * next launch can retry.
     */
    private fun isSessionRevocation(statusCode: Int, body: String): Boolean {
        if (statusCode != 401) return false
        val code = runCatching {
            json.parseToJsonElement(body).jsonObject["code"]?.jsonPrimitive?.contentOrNull
        }.getOrNull()
        return code == "AUTH_SESSION_REVOKED" || code == "AUTH_INVALID_CREDENTIALS"
    }

    private fun newRefreshCandidate(): String {
        val bytes = ByteArray(48)
        secureRandom.nextBytes(bytes)
        return Base64.encodeToString(
            bytes,
            Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP,
        )
    }

    private fun requestNativeChallenge(origin: String = requestSession.get()?.origin ?: authManager.hubOrigin): String? {
        val request = Request.Builder()
            .url("$origin/api/v1/auth/native/challenge")
            .header("Origin", nativeOrigin)
            .header("Accept", "application/json")
            .header("X-Client-Id", authManager.clientId)
            .post("{}".toRequestBody(jsonMediaType))
            .build()
        return try {
            rawHttpClient.newCall(request).executeTracked().use { response ->
                val body = response.body?.string() ?: ""
                if (!response.isSuccessful) throw apiFailure("native auth challenge", response, body)
                json.decodeFromString<NativeChallengeResponse>(body).challenge
            }
        } catch (e: ApiClientException) {
            throw e
        } catch (_: Exception) {
            null
        }
    }

    private fun responseCount(response: Response): Int {
        var count = 1
        var prior = response.priorResponse
        while (prior != null) {
            count += 1
            prior = prior.priorResponse
        }
        return count
    }

    suspend fun pushSync(mutations: List<Mutation>): Result<PushResult> = inSession {
        try {
            val pushReq = PushRequest(
                protocolVersion = 1,
                clientId = authManager.clientId,
                mutations = mutations
            )
            val req = Request.Builder()
                .url("${baseUrl()}/sync/push")
                .post(json.encodeToString(pushReq).toRequestBody(jsonMediaType))
                .build()
            authenticatedCall(req).awaitResponse().use { resp ->
                val bodyStr = resp.body?.string() ?: ""
                if (resp.isSuccessful) {
                    Result.success(json.decodeFromString<PushResult>(bodyStr))
                } else {
                    Result.failure(apiFailure("v1 push", resp, bodyStr))
                }
            }
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    suspend fun pullSync(cursor: String, limit: Int = 100): Result<PullResult> = inSession {
        try {
            val req = Request.Builder()
                .url("${baseUrl()}/sync/pull?cursor=$cursor&limit=$limit")
                .get()
                .build()
            authenticatedCall(req).awaitResponse().use { resp ->
                val bodyStr = resp.body?.string() ?: ""
                if (resp.isSuccessful) {
                    Result.success(json.decodeFromString<PullResult>(bodyStr))
                } else {
                    Result.failure(apiFailure("v1 pull", resp, bodyStr))
                }
            }
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    suspend fun getSnapshot(): Result<SnapshotResult> = inSession {
        try {
            val req = Request.Builder()
                .url("${baseUrl()}/sync/snapshot")
                .get()
                .build()
            authenticatedCall(req).awaitResponse().use { resp ->
                val bodyStr = resp.body?.string() ?: ""
                if (resp.isSuccessful) {
                    Result.success(json.decodeFromString<SnapshotResult>(bodyStr))
                } else {
                    Result.failure(apiFailure("v1 snapshot", resp, bodyStr))
                }
            }
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    suspend fun pushSyncV2(mutations: List<Mutation>): Result<PushResult> = inSession {
        try {
            val pushReq = V2PushRequest(
                protocolVersion = 2,
                clientId = authManager.clientId,
                mutations = mutations
            )
            val req = Request.Builder()
                .url("${baseUrlV2()}/sync/push")
                .post(json.encodeToString(pushReq).toRequestBody(jsonMediaType))
                .build()
            authenticatedCall(req).awaitResponse().use { resp ->
                val bodyStr = resp.body?.string() ?: ""
                if (resp.isSuccessful) Result.success(json.decodeFromString<PushResult>(bodyStr))
                else Result.failure(apiFailure("v2 push", resp, bodyStr))
            }
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    suspend fun pullSyncV2(cursor: String, limit: Int = 100): Result<PullResult> = inSession {
        try {
            val req = Request.Builder()
                .url("${baseUrlV2()}/sync/pull?cursor=$cursor&limit=$limit")
                .get()
                .build()
            authenticatedCall(req).awaitResponse().use { resp ->
                val bodyStr = resp.body?.string() ?: ""
                if (resp.isSuccessful) Result.success(json.decodeFromString<PullResult>(bodyStr))
                else Result.failure(apiFailure("v2 pull", resp, bodyStr))
            }
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    suspend fun getSnapshotV2(): Result<V2SnapshotResult> = inSession {
        try {
            val req = Request.Builder()
                .url("${baseUrlV2()}/sync/snapshot")
                .get()
                .build()
            authenticatedCall(req).awaitResponse().use { resp ->
                val bodyStr = resp.body?.string() ?: ""
                if (resp.isSuccessful) Result.success(decodeSnapshot(bodyStr))
                else Result.failure(apiFailure("v2 snapshot", resp, bodyStr))
            }
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    suspend fun getV2DeletePreview(folderId: String): Result<DeletePreviewDto> = inSession {
        try {
            val req = Request.Builder()
                .url("${baseUrlV2()}/folders/$folderId/delete-preview")
                .post("{}".toRequestBody(jsonMediaType))
                .build()
            authenticatedCall(req).awaitResponse().use { resp ->
                val bodyStr = resp.body?.string() ?: ""
                if (resp.isSuccessful) Result.success(json.decodeFromString<DeletePreviewDto>(bodyStr))
                else Result.failure(apiFailure("v2 delete preview", resp, bodyStr))
            }
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    private fun decodeSnapshot(body: String): V2SnapshotResult {
        val value = json.parseToJsonElement(body).jsonObject
        require(listOf("folders", "tasks", "notes", "taskSteps", "timePoints", "placements",
            "workflows", "workflowStages", "workflowTaskMemberships", "settings", "cursor").all { it in value }) {
            "中枢返回了不完整快照，已保留本地缓存"
        }
        return json.decodeFromJsonElement(value)
    }

    private suspend inline fun <reified T> v2Request(path: String, body: String? = null): Result<T> = inSession {
        try {
            val started = System.nanoTime()
            val builder = Request.Builder().url("${baseUrlV2()}$path")
            val request = if (body == null) builder.get().build() else builder.post(body.toRequestBody(jsonMediaType)).build()
            authenticatedCall(request).awaitResponse().use { response ->
                val text = response.body?.string().orEmpty()
                if (response.isSuccessful) {
                    val received = System.nanoTime()
                    val decoded = json.decodeFromString<T>(text)
                    val route = if (path.startsWith("/tasks/")) "task.detail" else path.substringBefore('?').split('/').take(3).joinToString("/")
                    android.util.Log.d("TaskDockSync", "route=$route receiveMs=${(received - started) / 1_000_000} parseMs=${(System.nanoTime() - received) / 1_000_000} chars=${text.length} requestId=${response.header("X-Request-Id").orEmpty()}")
                    Result.success(decoded)
                }
                else Result.failure(apiFailure("v2 request", response, text))
            }
        } catch (error: CancellationException) { throw error }
        catch (error: Exception) { Result.failure(error) }
    }
    suspend fun syncCapabilities(): Result<SyncCapabilities> = v2Request("/sync/capabilities")
    suspend fun syncPreview(date: String, folderId: String? = null): Result<SyncPreview> = v2Request("/sync/preview?localDate=$date&parentFolderId=${folderId ?: "root"}")
    suspend fun createBootstrap(date: String): Result<BootstrapManifest> = v2Request("/sync/bootstrap", "{\"localDate\":\"$date\"}")
    suspend fun bootstrapPage(id: String, page: Int): Result<BootstrapPage> = v2Request("/sync/bootstrap/$id?page=$page")
    suspend fun taskDetails(id: String): Result<TaskDetailV2Dto> = v2Request("/tasks/$id")

    suspend fun deleteV2Tree(folderId: String, confirmationToken: String): Result<Unit> = inSession {
        try {
            val req = Request.Builder()
                .url("${baseUrlV2()}/folders/$folderId/tree")
                .header("X-Client-Id", authManager.clientId)
                .header("Idempotency-Key", java.util.UUID.randomUUID().toString())
                .delete("{\"confirmationToken\":\"$confirmationToken\"}".toRequestBody(jsonMediaType))
                .build()
            authenticatedCall(req).awaitResponse().use { resp ->
                val bodyStr = resp.body?.string() ?: ""
                if (resp.isSuccessful) Result.success(Unit)
                else Result.failure(apiFailure("v2 delete tree", resp, bodyStr))
            }
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    fun createWebSocket(listener: WebSocketListener): WebSocket {
        val wsUrl = authManager.hubOrigin
            .replace("http://", "ws://")
            .replace("https://", "wss://") + "/api/v1/ws"
        val req = Request.Builder()
            .url(wsUrl)
            .header("Authorization", "Bearer ${authManager.accessToken ?: ""}")
            .build()
        return okHttpClient.newWebSocket(req, listener)
    }

    fun createV2WebSocket(listener: WebSocketListener): WebSocket {
        val session = authManager.sessionKey
        val accessToken = authManager.accessToken.orEmpty()
        val wsUrl = authManager.hubOrigin
            .replace("http://", "ws://")
            .replace("https://", "wss://") + "/api/v2/ws"
        val req = Request.Builder()
            .url(wsUrl)
            .build()
        // v2 authenticates with the first WebSocket message. Keep the
        // handshake free of bearer headers so all clients share one contract.
        return rawHttpClient.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (session != authManager.sessionKey) { webSocket.cancel(); return }
                webSocket.send("{\"type\":\"auth\",\"accessToken\":\"$accessToken\"}")
                listener.onOpen(webSocket, response)
            }

            override fun onMessage(webSocket: WebSocket, text: String) = listener.onMessage(webSocket, text)
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) = listener.onClosing(webSocket, code, reason)
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = listener.onClosed(webSocket, code, reason)
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = listener.onFailure(webSocket, t, response)
        })
    }

    private fun apiFailure(operation: String, response: Response, body: String): ApiClientException {
        val payload = runCatching { json.parseToJsonElement(body).jsonObject }.getOrNull()
        val code = payload?.get("code")?.jsonPrimitive?.contentOrNull
        val message = payload?.get("message")?.jsonPrimitive?.contentOrNull
            ?: "${operation} failed with HTTP ${response.code}"
        val category = when {
            code == "AUTH_CHALLENGE_INVALID" -> ApiFailureCategory.REQUEST_REJECTED
            response.code == 401 || response.code == 403 -> ApiFailureCategory.AUTH_REQUIRED
            code == "SYNC_CURSOR_EXPIRED" -> ApiFailureCategory.CURSOR_EXPIRED
            (response.code == 404 && code != "ENTITY_NOT_FOUND") || code == "CLIENT_UPGRADE_REQUIRED" || code == "SYNC_PROTOCOL_UNSUPPORTED" ->
                ApiFailureCategory.INCOMPATIBLE
            response.code >= 500 -> ApiFailureCategory.SERVER_UNAVAILABLE
            else -> ApiFailureCategory.REQUEST_REJECTED
        }
        return ApiClientException(response.code, code, category, message)
    }
}

@kotlinx.serialization.Serializable
private data class NativeChallengeResponse(val challenge: String)
