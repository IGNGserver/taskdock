package com.devtodo.app.data.security

import android.content.Context
import android.content.SharedPreferences
import androidx.core.content.edit
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

class SecureAuthManager(context: Context) {
    private val masterKey = MasterKey.Builder(context)
        .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
        .build()

    private val prefs: SharedPreferences = try {
        EncryptedSharedPreferences.create(
            context,
            "devtodo_secure_auth",
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    } catch (e: Exception) {
        context.getSharedPreferences("devtodo_fallback_auth", Context.MODE_PRIVATE)
    }

    private val plainPrefs: SharedPreferences =
        context.getSharedPreferences("devtodo_config", Context.MODE_PRIVATE)

    companion object {
        private const val KEY_ACCESS_TOKEN = "access_token"
        private const val KEY_REFRESH_TOKEN = "refresh_token"
        private const val KEY_HUB_ORIGIN = "hub_origin"
        private const val KEY_OWNER_ID = "owner_id"
        private const val KEY_USERNAME = "username"
        private const val KEY_CLIENT_ID = "client_id"
        private const val KEY_THEME_MODE = "theme_mode"
        private const val KEY_DYNAMIC_COLOR = "dynamic_color"
        private const val KEY_PURE_BLACK = "pure_black"
        private const val DEFAULT_HUB_ORIGIN = "http://47.95.17.77:48731"
    }

    var accessToken: String?
        get() = prefs.getString(KEY_ACCESS_TOKEN, null)
        set(value) = prefs.edit { putString(KEY_ACCESS_TOKEN, value) }

    var refreshToken: String?
        get() = prefs.getString(KEY_REFRESH_TOKEN, null)
        set(value) = prefs.edit { putString(KEY_REFRESH_TOKEN, value) }

    var hubOrigin: String
        get() = plainPrefs.getString(KEY_HUB_ORIGIN, DEFAULT_HUB_ORIGIN) ?: DEFAULT_HUB_ORIGIN
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
        get() = !accessToken.isNullOrEmpty() || !refreshToken.isNullOrEmpty()

    fun clearSession() {
        prefs.edit {
            remove(KEY_ACCESS_TOKEN)
            remove(KEY_REFRESH_TOKEN)
        }
        plainPrefs.edit {
            remove(KEY_OWNER_ID)
            remove(KEY_USERNAME)
        }
    }
}
