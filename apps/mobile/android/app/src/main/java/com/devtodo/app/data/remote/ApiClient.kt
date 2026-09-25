package com.devtodo.app.data.remote

import android.util.Base64
import com.devtodo.app.data.model.*
import com.devtodo.app.data.security.SecureAuthManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.security.SecureRandom
import java.util.concurrent.TimeUnit

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
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .writeTimeout(15, TimeUnit.SECONDS)
        .pingInterval(30, TimeUnit.SECONDS)
        .build()

    private val okHttpClient = rawHttpClient.newBuilder()
        .addInterceptor { chain ->
            val original = chain.request()
            val builder = original.newBuilder()
                .header("Accept", "application/json")
                .header("X-Client-Id", authManager.clientId)
            authManager.accessToken?.let { token ->
                builder.header("Authorization", "Bearer $token")
            }
            chain.proceed(builder.build())
        }
        .authenticator { _, response -> authenticate(response) }
        .build()

    private fun baseUrl(): String = "${authManager.hubOrigin}/api/v1"
    private fun baseUrlV2(): String = "${authManager.hubOrigin}/api/v2"

    suspend fun checkHubStatus(origin: String): Result<HubStatusResponse> = withContext(Dispatchers.IO) {
        try {
            val req = Request.Builder()
                .url("${origin.trimEnd('/')}/api/v1/bootstrap/status")
                .get()
                .build()
            okHttpClient.newCall(req).execute().use { resp ->
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

    suspend fun login(username: String, password: String): Result<LoginResponse> = withContext(Dispatchers.IO) {
        try {
            val challenge = requestNativeChallenge()
                ?: return@withContext Result.failure(IOException("Native auth challenge failed"))
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
            okHttpClient.newCall(req).execute().use { resp ->
                val bodyStr = resp.body?.string() ?: ""
                if (resp.isSuccessful) {
                    val loginRes = json.decodeFromString<LoginResponse>(bodyStr)
                    val refreshToken = loginRes.refreshToken
                        ?: return@use Result.failure(IOException("Login response missing refresh token"))
                    authManager.setSessionTokens(loginRes.accessToken, refreshToken)
                    authManager.ownerId = loginRes.user.id
                    authManager.username = loginRes.user.username
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
        val nextAccessToken = authManager.accessToken ?: return null
        return response.request.newBuilder()
            .header("Authorization", "Bearer $nextAccessToken")
            .build()
    }

    private fun refreshSession(failedAccessToken: String?): Boolean {
        synchronized(refreshLock) {
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
                requestNativeChallenge()
            } catch (_: ApiClientException) {
                // Session restoration is best-effort. Keep local data usable
                // when the challenge service rejects or cannot serve a request.
                return false
            } ?: return false
            val payload = json.encodeToString(
                mapOf(
                    "refreshToken" to refreshToken,
                    "nextRefreshToken" to candidate,
                    "nativeChallenge" to challenge
                )
            )
            val request = Request.Builder()
                .url("${baseUrl()}/auth/refresh")
                .header("Origin", nativeOrigin)
                .header("X-Client-Id", authManager.clientId)
                .post(payload.toRequestBody(jsonMediaType))
                .build()
            return try {
                rawHttpClient.newCall(request).execute().use { response ->
                    val body = response.body?.string() ?: ""
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

    private fun requestNativeChallenge(): String? {
        val request = Request.Builder()
            .url("${baseUrl()}/auth/native/challenge")
            .header("Origin", nativeOrigin)
            .header("Accept", "application/json")
            .header("X-Client-Id", authManager.clientId)
            .post("{}".toRequestBody(jsonMediaType))
            .build()
        return try {
            rawHttpClient.newCall(request).execute().use { response ->
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

    suspend fun pushSync(mutations: List<Mutation>): Result<PushResult> = withContext(Dispatchers.IO) {
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
            okHttpClient.newCall(req).execute().use { resp ->
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

    suspend fun pullSync(cursor: String, limit: Int = 100): Result<PullResult> = withContext(Dispatchers.IO) {
        try {
            val req = Request.Builder()
                .url("${baseUrl()}/sync/pull?cursor=$cursor&limit=$limit")
                .get()
                .build()
            okHttpClient.newCall(req).execute().use { resp ->
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

    suspend fun getSnapshot(): Result<SnapshotResult> = withContext(Dispatchers.IO) {
        try {
            val req = Request.Builder()
                .url("${baseUrl()}/sync/snapshot")
                .get()
                .build()
            okHttpClient.newCall(req).execute().use { resp ->
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

    suspend fun pushSyncV2(mutations: List<Mutation>): Result<PushResult> = withContext(Dispatchers.IO) {
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
            okHttpClient.newCall(req).execute().use { resp ->
                val bodyStr = resp.body?.string() ?: ""
                if (resp.isSuccessful) Result.success(json.decodeFromString<PushResult>(bodyStr))
                else Result.failure(apiFailure("v2 push", resp, bodyStr))
            }
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    suspend fun pullSyncV2(cursor: String, limit: Int = 100): Result<PullResult> = withContext(Dispatchers.IO) {
        try {
            val req = Request.Builder()
                .url("${baseUrlV2()}/sync/pull?cursor=$cursor&limit=$limit")
                .get()
                .build()
            okHttpClient.newCall(req).execute().use { resp ->
                val bodyStr = resp.body?.string() ?: ""
                if (resp.isSuccessful) Result.success(json.decodeFromString<PullResult>(bodyStr))
                else Result.failure(apiFailure("v2 pull", resp, bodyStr))
            }
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    suspend fun getSnapshotV2(): Result<V2SnapshotResult> = withContext(Dispatchers.IO) {
        try {
            val req = Request.Builder()
                .url("${baseUrlV2()}/sync/snapshot")
                .get()
                .build()
            okHttpClient.newCall(req).execute().use { resp ->
                val bodyStr = resp.body?.string() ?: ""
                if (resp.isSuccessful) Result.success(json.decodeFromString<V2SnapshotResult>(bodyStr))
                else Result.failure(apiFailure("v2 snapshot", resp, bodyStr))
            }
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    suspend fun getV2DeletePreview(folderId: String): Result<DeletePreviewDto> = withContext(Dispatchers.IO) {
        try {
            val req = Request.Builder()
                .url("${baseUrlV2()}/folders/$folderId/delete-preview")
                .post("{}".toRequestBody(jsonMediaType))
                .build()
            okHttpClient.newCall(req).execute().use { resp ->
                val bodyStr = resp.body?.string() ?: ""
                if (resp.isSuccessful) Result.success(json.decodeFromString<DeletePreviewDto>(bodyStr))
                else Result.failure(apiFailure("v2 delete preview", resp, bodyStr))
            }
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    suspend fun deleteV2Tree(folderId: String, confirmationToken: String): Result<Unit> = withContext(Dispatchers.IO) {
        try {
            val req = Request.Builder()
                .url("${baseUrlV2()}/folders/$folderId/tree")
                .header("X-Client-Id", authManager.clientId)
                .header("Idempotency-Key", java.util.UUID.randomUUID().toString())
                .delete("{\"confirmationToken\":\"$confirmationToken\"}".toRequestBody(jsonMediaType))
                .build()
            okHttpClient.newCall(req).execute().use { resp ->
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
                val accessToken = authManager.accessToken ?: ""
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
            response.code == 404 || code == "CLIENT_UPGRADE_REQUIRED" || code == "SYNC_PROTOCOL_UNSUPPORTED" ->
                ApiFailureCategory.INCOMPATIBLE
            response.code >= 500 -> ApiFailureCategory.SERVER_UNAVAILABLE
            else -> ApiFailureCategory.REQUEST_REJECTED
        }
        return ApiClientException(response.code, code, category, message)
    }
}

@kotlinx.serialization.Serializable
private data class NativeChallengeResponse(val challenge: String)
