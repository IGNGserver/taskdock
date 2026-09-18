package com.devtodo.app.data.security

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import org.json.JSONTokener
import java.nio.charset.StandardCharsets
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

internal const val AUTH_ACCESS_TOKEN_KEY = "access_token"
internal const val AUTH_REFRESH_TOKEN_KEY = "refresh_token"

/**
 * Stores native session tokens without ever writing new plaintext token values.
 *
 * The primary store keeps the existing EncryptedSharedPreferences name so an
 * in-place upgrade remains compatible. If AndroidX encryption cannot open the
 * file, the fallback still stores ciphertext protected by an Android Keystore
 * key. This keeps a transient AndroidX/Keystore failure from silently switching
 * between two plaintext preference files.
 */
internal class SecureTokenStore(context: Context) {
    private val appContext = context.applicationContext
    private val lock = Any()
    private val primaryPrefs: SharedPreferences? = createPrimaryPrefs()
    private val encryptedFallbackPrefs: SharedPreferences = appContext.getSharedPreferences(
        ENCRYPTED_FALLBACK_PREFS,
        Context.MODE_PRIVATE,
    )

    init {
        migrateLegacyStores()
    }

    fun get(key: String): String? = synchronized(lock) {
        readValueLocked(key)
    }

    fun put(key: String, value: String) {
        putAll(mapOf(key to value))
    }

    fun putAll(values: Map<String, String>) = synchronized(lock) {
        require(values.isNotEmpty())
        if (primaryPrefs?.let { writePrimary(it, values) } == true) {
            removeFallbackValues(values.keys)
            return@synchronized
        }

        val editor = encryptedFallbackPrefs.edit()
        values.forEach { (key, value) ->
            editor.putString(key, encryptFallback(value))
        }
        check(editor.commit()) { "无法保存加密登录凭证" }
    }

    fun remove(key: String) = synchronized(lock) {
        primaryPrefs?.edit()?.remove(key)?.commit()
        encryptedFallbackPrefs.edit().remove(key).commit()
    }

    fun removeAll(keys: Set<String>) = synchronized(lock) {
        if (keys.isEmpty()) return@synchronized
        primaryPrefs?.edit()?.apply {
            keys.forEach { key -> this.remove(key) }
        }?.commit()
        encryptedFallbackPrefs.edit().apply {
            keys.forEach { key -> this.remove(key) }
        }.commit()
    }

    private fun createPrimaryPrefs(): SharedPreferences? = try {
        val masterKey = MasterKey.Builder(appContext)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            appContext,
            PRIMARY_PREFS,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    } catch (_: Exception) {
        null
    }

    private fun readValueLocked(key: String): String? {
        val primary = runCatching { primaryPrefs?.getString(key, null) }.getOrNull()
        if (!primary.isNullOrBlank()) return primary

        val encryptedFallback = encryptedFallbackPrefs.getString(key, null) ?: return null
        val fallback = runCatching { decryptFallback(encryptedFallback) }.getOrNull() ?: return null

        // Heal the primary store when it becomes available after a transient
        // AndroidX/Keystore error. The fallback is removed only after commit.
        if (primaryPrefs?.let { writePrimary(it, mapOf(key to fallback)) } == true) {
            encryptedFallbackPrefs.edit().remove(key).commit()
        }
        return fallback
    }

    private fun writePrimary(prefs: SharedPreferences, values: Map<String, String>): Boolean = try {
        val editor = prefs.edit()
        values.forEach { (key, value) -> editor.putString(key, value) }
        editor.commit()
    } catch (_: Exception) {
        false
    }

    private fun removeFallbackValues(keys: Set<String>) {
        encryptedFallbackPrefs.edit().apply {
            keys.forEach { key -> this.remove(key) }
        }.commit()
    }

    private fun migrateLegacyStores() = synchronized(lock) {
        if (!readValueLocked(AUTH_REFRESH_TOKEN_KEY).isNullOrBlank()) return@synchronized

        val legacyToken = readCapacitorRefreshToken() ?: readPlainFallbackRefreshToken() ?: return@synchronized
        try {
            put(AUTH_REFRESH_TOKEN_KEY, legacyToken)
        } catch (_: Exception) {
            // Keep the legacy value intact. A future launch can retry the
            // migration after Android Keystore becomes available again.
            return@synchronized
        }

        if (readValueLocked(AUTH_REFRESH_TOKEN_KEY) == legacyToken) {
            removeCapacitorRefreshToken()
            removePlainFallbackRefreshToken()
        }
    }

    /** Reads the token written by @aparajita/capacitor-secure-storage v8. */
    private fun readCapacitorRefreshToken(): String? {
        return try {
            val preferences = appContext.getSharedPreferences(LEGACY_CAPACITOR_PREFS, Context.MODE_PRIVATE)
            val stored = preferences.getString(LEGACY_CAPACITOR_KEY, null) ?: return null
            val parts = stored.split(LEGACY_IV_SEPARATOR)
            if (parts.size != 2) return null

            val keyStore = KeyStore.getInstance(ANDROID_KEY_STORE).apply { load(null) }
            val entry = keyStore.getEntry(LEGACY_CAPACITOR_KEY, null) as? KeyStore.SecretKeyEntry
                ?: return null
            val cipher = Cipher.getInstance(AES_GCM)
            cipher.init(
                Cipher.DECRYPT_MODE,
                entry.secretKey,
                GCMParameterSpec(128, Base64.decode(parts[1], BASE64_FLAGS)),
            )
            val jsonValue = String(
                cipher.doFinal(Base64.decode(parts[0], BASE64_FLAGS)),
                StandardCharsets.UTF_8,
            )
            (JSONTokener(jsonValue).nextValue() as? String)?.takeIf { it.isNotBlank() }
        } catch (_: Exception) {
            null
        }
    }

    /** Reads plaintext tokens left by the short-lived Compose fallback implementation. */
    private fun readPlainFallbackRefreshToken(): String? = runCatching {
        appContext.getSharedPreferences(PLAIN_FALLBACK_PREFS, Context.MODE_PRIVATE)
            .getString(AUTH_REFRESH_TOKEN_KEY, null)
            ?.takeIf { it.isNotBlank() }
    }.getOrNull()

    private fun removeCapacitorRefreshToken() {
        runCatching {
            appContext.getSharedPreferences(LEGACY_CAPACITOR_PREFS, Context.MODE_PRIVATE)
                .edit()
                .remove(LEGACY_CAPACITOR_KEY)
                .commit()
            val keyStore = KeyStore.getInstance(ANDROID_KEY_STORE).apply { load(null) }
            if (keyStore.containsAlias(LEGACY_CAPACITOR_KEY)) keyStore.deleteEntry(LEGACY_CAPACITOR_KEY)
        }
    }

    private fun removePlainFallbackRefreshToken() {
        runCatching {
            appContext.getSharedPreferences(PLAIN_FALLBACK_PREFS, Context.MODE_PRIVATE)
                .edit()
                .remove(AUTH_REFRESH_TOKEN_KEY)
                .remove(AUTH_ACCESS_TOKEN_KEY)
                .commit()
        }
    }

    private fun encryptFallback(value: String): String {
        val cipher = Cipher.getInstance(AES_GCM)
        cipher.init(Cipher.ENCRYPT_MODE, fallbackKey())
        val ciphertext = cipher.doFinal(value.toByteArray(StandardCharsets.UTF_8))
        val iv = Base64.encodeToString(cipher.iv, BASE64_FLAGS)
        val data = Base64.encodeToString(ciphertext, BASE64_FLAGS)
        return "$data$LEGACY_IV_SEPARATOR$iv"
    }

    private fun decryptFallback(value: String): String {
        val parts = value.split(LEGACY_IV_SEPARATOR)
        require(parts.size == 2) { "无效的加密登录凭证" }
        val cipher = Cipher.getInstance(AES_GCM)
        cipher.init(
            Cipher.DECRYPT_MODE,
            fallbackKey(),
            GCMParameterSpec(128, Base64.decode(parts[1], BASE64_FLAGS)),
        )
        return String(
            cipher.doFinal(Base64.decode(parts[0], BASE64_FLAGS)),
            StandardCharsets.UTF_8,
        )
    }

    private fun fallbackKey(): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEY_STORE).apply { load(null) }
        (keyStore.getKey(FALLBACK_KEY_ALIAS, null) as? SecretKey)?.let { return it }

        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEY_STORE)
        generator.init(
            KeyGenParameterSpec.Builder(
                FALLBACK_KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build(),
        )
        return generator.generateKey()
    }

    private companion object {
        const val PRIMARY_PREFS = "devtodo_secure_auth"
        const val ENCRYPTED_FALLBACK_PREFS = "devtodo_secure_auth_fallback"
        const val PLAIN_FALLBACK_PREFS = "devtodo_fallback_auth"
        const val LEGACY_CAPACITOR_PREFS = "WSSecureStorageSharedPreferences"
        const val LEGACY_CAPACITOR_KEY = "devtodo_refresh-token"
        const val FALLBACK_KEY_ALIAS = "com.devtodo.app.auth.fallback.v1"
        const val ANDROID_KEY_STORE = "AndroidKeyStore"
        const val AES_GCM = "AES/GCM/NoPadding"
        const val LEGACY_IV_SEPARATOR = '\u0010'
        const val BASE64_FLAGS = Base64.NO_PADDING or Base64.NO_WRAP
    }
}
