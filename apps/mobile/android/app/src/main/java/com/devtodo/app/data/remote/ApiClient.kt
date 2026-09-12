package com.devtodo.app.data.remote

import com.devtodo.app.data.model.*
import com.devtodo.app.data.security.SecureAuthManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

class ApiClient(private val authManager: SecureAuthManager) {
    val json = Json {
        ignoreUnknownKeys = true
        isLenient = true
        encodeDefaults = true
    }

    private val jsonMediaType = "application/json; charset=utf-8".toMediaType()
    private val refreshLock = Any()
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

    suspend fun checkHubStatus(origin: String): Result<HubStatusResponse> = withContext(Dispatchers.IO) {
        try {
            val req = Request.Builder()
                .url("${origin.trimEnd('/')}/api/v1/hub/status")
                .get()
                .build()
            okHttpClient.newCall(req).execute().use { resp ->
                val bodyStr = resp.body?.string() ?: ""
                if (resp.isSuccessful) {
                    val status = json.decodeFromString<HubStatusResponse>(bodyStr)
                    Result.success(status)
                } else {
                    Result.failure(IOException("Server returned ${resp.code}: $bodyStr"))
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
                    authManager.accessToken = loginRes.accessToken
                    authManager.refreshToken = refreshToken
                    authManager.ownerId = loginRes.user.id
                    authManager.username = loginRes.user.username
                    Result.success(loginRes)
                } else {
                    Result.failure(IOException("Login failed (${resp.code}): $bodyStr"))
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
            val challenge = requestNativeChallenge() ?: return false
            val payload = json.encodeToString(
                mapOf(
                    "refreshToken" to refreshToken,
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
                        if (response.code == 401) authManager.clearSession()
                        false
                    } else {
                        val result = json.decodeFromString<LoginResponse>(body)
                        val nextRefreshToken = result.refreshToken ?: return@use false
                        authManager.accessToken = result.accessToken
                        authManager.refreshToken = nextRefreshToken
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

    private fun requestNativeChallenge(): String? {
        val request = Request.Builder()
            .url("${baseUrl()}/auth/native/challenge")
            .header("Origin", nativeOrigin)
            .header("Accept", "application/json")
            .post("".toRequestBody(jsonMediaType))
            .build()
        return try {
            rawHttpClient.newCall(request).execute().use { response ->
                if (!response.isSuccessful) return@use null
                val body = response.body?.string() ?: return@use null
                json.decodeFromString<NativeChallengeResponse>(body).challenge
            }
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
                    Result.failure(IOException("Push failed: ${resp.code} $bodyStr"))
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
                    Result.failure(IOException("Pull failed: ${resp.code} $bodyStr"))
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
                    Result.failure(IOException("Snapshot failed: ${resp.code} $bodyStr"))
                }
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
}

@kotlinx.serialization.Serializable
private data class NativeChallengeResponse(val challenge: String)
