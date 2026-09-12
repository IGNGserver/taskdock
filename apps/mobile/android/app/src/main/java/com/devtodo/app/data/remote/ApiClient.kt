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

    private val okHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .writeTimeout(15, TimeUnit.SECONDS)
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
            val payload = json.encodeToString(mapOf("username" to username, "password" to password))
            val req = Request.Builder()
                .url("${baseUrl()}/auth/login")
                .post(payload.toRequestBody(jsonMediaType))
                .build()
            okHttpClient.newCall(req).execute().use { resp ->
                val bodyStr = resp.body?.string() ?: ""
                if (resp.isSuccessful) {
                    val loginRes = json.decodeFromString<LoginResponse>(bodyStr)
                    authManager.accessToken = loginRes.accessToken
                    loginRes.refreshToken?.let { authManager.refreshToken = it }
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
