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
internal const val AUTH_PENDING_REFRESH_TOKEN_KEY = "pending_refresh_token"

/**
 * Stores native session tokens without ever writing new plaintext token values.
 *
 * Every value is written to both the AndroidX encrypted file and a Keystore
 * backed fallback file. The AndroidX master key used to be invalidated by
 * biometric re-enrollment, and Keystore reads transiently fail right after a
 * device reboot, so a single unreadable file must never be able to destroy a
 * durable login credential. Reads prefer the primary file and heal whichever
 * copy was unavailable.
 */
internal class SecureTokenStore(context: Context) {
    private val appContext = context.applicationContext
    private val lock = Any()
    private var primaryPrefs: SharedPreferences? = null
    private var lastPrimaryAttemptMs = 0L
    private val encryptedFallbackPrefs: SharedPreferences = appContext.getSharedPreferences(
        ENCRYPTED_FALLBACK_PREFS,
        Context.MODE_PRIVATE,
    )

    init {
        primary()
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
        val primaryWritten = primary()?.let { writePrimary(it, values) } == true
        val fallbackWritten = runCatching { writeFallback(values) }.getOrDefault(false)
        if (!primaryWritten && !fallbackWritten) {
            error("无法保存加密登录凭证")
        }
        Unit
    }

    fun remove(key: String) = synchronized(lock) {
        primary()?.edit()?.remove(key)?.commit()
        encryptedFallbackPrefs.edit().remove(key).commit()
    }

    fun removeAll(keys: Set<String>) = synchronized(lock) {
        if (keys.isEmpty()) return@synchronized
        primary()?.edit()?.apply {
            keys.forEach { key -> this.remove(key) }
        }?.commit()
        encryptedFallbackPrefs.edit().apply {
            keys.forEach { key -> this.remove(key) }
        }.commit()
    }

    /**
     * Drops the cached handle and tries the AndroidX file again right away,
     * ignoring the retry interval. Used when the app is about to tell the user
     * they are signed out, which is the worst moment to rely on a stale handle.
     */
    fun forceReopenPrimary() = synchronized(lock) {
        primaryPrefs = createPrimaryPrefs()
        lastPrimaryAttemptMs = android.os.SystemClock.elapsedRealtime()
        primaryPrefs != null
    }

    /**
     * Reopens the AndroidX store on demand. A cold device boot can make
     * Keystore answer "uninitialized" for the first few attempts, and a handle
     * that gave up there would keep reporting a logged-out app forever.
     */
    private fun primary(): SharedPreferences? {
        primaryPrefs?.let { return it }
        val now = android.os.SystemClock.elapsedRealtime()
        if (now - lastPrimaryAttemptMs < PRIMARY_RETRY_INTERVAL_MS) return null
        lastPrimaryAttemptMs = now
        return createPrimaryPrefs()?.also { primaryPrefs = it }
    }

    private fun createPrimaryPrefs(): SharedPreferences? = try {
        // An installed app keeps its original master key, so this spec only
        // protects keys generated from now on; the duplicate copy below is
        // what saves an upgrade that already owns a biometric-invalidated key.
        val masterKey = MasterKey.Builder(appContext)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .setUserAuthenticationRequired(false)
            .setInvalidatedByBiometricEnrollment(false)
            .build()
        EncryptedSharedPreferences.create(
            appContext,
            PRIMARY_PREFS,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    } catch (failure: VirtualMachineError) {
        throw failure
    } catch (_: Throwable) {
        null
    }

    private fun readValueLocked(key: String): String? {
        val primary = runCatching { primary()?.getString(key, null) }.getOrNull()
        if (!primary.isNullOrBlank()) return primary

        val encryptedFallback = encryptedFallbackPrefs.getString(key, null) ?: return null
        val fallback = runCatching { decryptFallback(encryptedFallback) }.getOrNull() ?: return null

        // Heal the primary store when it becomes available after a transient
        // AndroidX/Keystore error. The fallback is kept as the second copy.
        primary()?.let { writePrimary(it, mapOf(key to fallback)) }
        return fallback
    }

    private fun writePrimary(prefs: SharedPreferences, values: Map<String, String>): Boolean = try {
        val editor = prefs.edit()
        values.forEach { (key, value) -> editor.putString(key, value) }
        editor.commit()
    } catch (_: Exception) {
        false
    }

    private fun writeFallback(values: Map<String, String>): Boolean {
        val editor = encryptedFallbackPrefs.edit()
        values.forEach { (key, value) ->
            editor.putString(key, encryptFallback(value))
        }
        return editor.commit()
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
        const val PRIMARY_RETRY_INTERVAL_MS = 10_000L
        const val ANDROID_KEY_STORE = "AndroidKeyStore"
        const val AES_GCM = "AES/GCM/NoPadding"
        const val LEGACY_IV_SEPARATOR = '\u0010'
        const val BASE64_FLAGS = Base64.NO_PADDING or Base64.NO_WRAP
    }
}
