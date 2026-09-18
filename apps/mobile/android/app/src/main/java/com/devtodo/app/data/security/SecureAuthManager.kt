package com.devtodo.app.data.security

import android.content.Context
import android.util.Base64
import androidx.core.content.edit
import org.json.JSONObject

class SecureAuthManager(context: Context) {
    private val tokenStore = SecureTokenStore(context)
    private val plainPrefs = context.applicationContext
        .getSharedPreferences("devtodo_config", Context.MODE_PRIVATE)

    companion object {
        private const val KEY_HUB_ORIGIN = "hub_origin"
        private const val KEY_OWNER_ID = "owner_id"
        private const val KEY_USERNAME = "username"
        private const val KEY_CLIENT_ID = "client_id"
        private const val KEY_THEME_MODE = "theme_mode"
        private const val KEY_DYNAMIC_COLOR = "dynamic_color"
        private const val KEY_PURE_BLACK = "pure_black"
    }

    var accessToken: String?
        get() = tokenStore.get(AUTH_ACCESS_TOKEN_KEY)
        set(value) {
            if (value.isNullOrBlank()) tokenStore.remove(AUTH_ACCESS_TOKEN_KEY)
            else tokenStore.put(AUTH_ACCESS_TOKEN_KEY, value)
        }

    var refreshToken: String?
        get() = tokenStore.get(AUTH_REFRESH_TOKEN_KEY)
        set(value) {
            if (value.isNullOrBlank()) tokenStore.remove(AUTH_REFRESH_TOKEN_KEY)
            else tokenStore.put(AUTH_REFRESH_TOKEN_KEY, value)
        }

    fun setSessionTokens(nextAccessToken: String, nextRefreshToken: String) {
        tokenStore.putAll(
            mapOf(
                AUTH_ACCESS_TOKEN_KEY to nextAccessToken,
                AUTH_REFRESH_TOKEN_KEY to nextRefreshToken,
            ),
        )
    }

    var hubOrigin: String
        get() = plainPrefs.getString(KEY_HUB_ORIGIN, "") ?: ""
        set(value) = plainPrefs.edit { putString(KEY_HUB_ORIGIN, value.trimEnd('/')) }

    var ownerId: String?
        get() = plainPrefs.getString(KEY_OWNER_ID, null)
        set(value) = plainPrefs.edit { putString(KEY_OWNER_ID, value) }

    var username: String?
        get() = plainPrefs.getString(KEY_USERNAME, null)
        set(value) = plainPrefs.edit { putString(KEY_USERNAME, value) }

    var clientId: String
        get() {
            var id = plainPrefs.getString(KEY_CLIENT_ID, null)
            if (id == null) {
                id = java.util.UUID.randomUUID().toString()
                plainPrefs.edit { putString(KEY_CLIENT_ID, id) }
            }
            return id
        }
        private set(_) {}

    var themeMode: String
        get() = plainPrefs.getString(KEY_THEME_MODE, "SYSTEM") ?: "SYSTEM"
        set(value) = plainPrefs.edit { putString(KEY_THEME_MODE, value) }

    var dynamicColor: Boolean
        get() = plainPrefs.getBoolean(KEY_DYNAMIC_COLOR, true)
        set(value) = plainPrefs.edit { putBoolean(KEY_DYNAMIC_COLOR, value) }

    var pureBlack: Boolean
        get() = plainPrefs.getBoolean(KEY_PURE_BLACK, false)
        set(value) = plainPrefs.edit { putBoolean(KEY_PURE_BLACK, value) }

    val isLoggedIn: Boolean
        get() = hasUsableAccessToken || !refreshToken.isNullOrEmpty()

    /**
     * Access tokens are deliberately short-lived. A persisted access token
     * alone is not a session, so an old APK must not reopen the workspace and
     * start syncing with an expired bearer token after an app restart.
     */
    val hasUsableAccessToken: Boolean
        get() = isAccessTokenUsable(accessToken)

    private fun isAccessTokenUsable(token: String?): Boolean {
        val payload = token
            ?.split('.')
            ?.getOrNull(1)
            ?.takeIf { it.isNotBlank() }
            ?: return false
        return try {
            val decoded = Base64.decode(
                payload,
                Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING
            )
            val expiresAtSeconds = JSONObject(String(decoded, Charsets.UTF_8)).optLong("exp", 0L)
            expiresAtSeconds > (System.currentTimeMillis() / 1000L) + 30L
        } catch (_: Exception) {
            false
        }
    }

    fun clearSession() {
        tokenStore.removeAll(setOf(AUTH_ACCESS_TOKEN_KEY, AUTH_REFRESH_TOKEN_KEY))
        plainPrefs.edit {
            remove(KEY_OWNER_ID)
            remove(KEY_USERNAME)
        }
    }
}
