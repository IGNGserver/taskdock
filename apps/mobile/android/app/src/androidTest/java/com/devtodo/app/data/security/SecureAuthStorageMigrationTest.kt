package com.devtodo.app.data.security

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.After
import org.junit.Before
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.nio.charset.StandardCharsets
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator

@RunWith(AndroidJUnit4::class)
class SecureAuthStorageMigrationTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    @Before
    fun resetStores() {
        cleanUp()
    }

    @After
    fun cleanUp() {
        runCatching { SecureAuthManager(context).clearSession() }
        context.getSharedPreferences("WSSecureStorageSharedPreferences", Context.MODE_PRIVATE)
            .edit()
            .clear()
            .commit()
        context.getSharedPreferences("devtodo_fallback_auth", Context.MODE_PRIVATE)
            .edit()
            .clear()
            .commit()
        context.getSharedPreferences("devtodo_secure_auth_fallback", Context.MODE_PRIVATE)
            .edit()
            .clear()
            .commit()
        runCatching {
            KeyStore.getInstance("AndroidKeyStore").apply {
                load(null)
                if (containsAlias(LEGACY_KEY)) deleteEntry(LEGACY_KEY)
            }
        }
    }

    @Test
    fun migratesCapacitorRefreshTokenToCurrentStore() {
        val token = "legacy-refresh-token-for-migration-test"
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        if (keyStore.containsAlias(LEGACY_KEY)) keyStore.deleteEntry(LEGACY_KEY)
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(
                LEGACY_KEY,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build(),
        )
        val key = generator.generateKey()
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key)
        val encrypted = Base64.encodeToString(
            cipher.doFinal(JSONObject.quote(token).toByteArray(StandardCharsets.UTF_8)),
            Base64.NO_PADDING or Base64.NO_WRAP,
        )
        val iv = Base64.encodeToString(cipher.iv, Base64.NO_PADDING or Base64.NO_WRAP)
        context.getSharedPreferences("WSSecureStorageSharedPreferences", Context.MODE_PRIVATE)
            .edit()
            .putString(LEGACY_KEY, "$encrypted\u0010$iv")
            .commit()

        val auth = SecureAuthManager(context)

        assertEquals(token, auth.refreshToken)
        assertEquals(token, SecureAuthManager(context).refreshToken)
        assertNull(
            context.getSharedPreferences("WSSecureStorageSharedPreferences", Context.MODE_PRIVATE)
                .getString(LEGACY_KEY, null),
        )
        val afterMigration = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        assertFalse(afterMigration.containsAlias(LEGACY_KEY))
    }

    @Test
    fun migratesPlaintextFallbackTokenIntoEncryptedStore() {
        val token = "compose-fallback-refresh-token-for-migration-test"
        context.getSharedPreferences("devtodo_fallback_auth", Context.MODE_PRIVATE)
            .edit()
            .putString(AUTH_REFRESH_TOKEN_KEY, token)
            .commit()

        val auth = SecureAuthManager(context)

        assertEquals(token, auth.refreshToken)
        assertNull(
            context.getSharedPreferences("devtodo_fallback_auth", Context.MODE_PRIVATE)
                .getString(AUTH_REFRESH_TOKEN_KEY, null),
        )
        assertNotEquals(
            token,
            context.getSharedPreferences("devtodo_secure_auth_fallback", Context.MODE_PRIVATE)
                .getString(AUTH_REFRESH_TOKEN_KEY, null),
        )
    }

    @Test
    fun keepsAKeystoreFallbackCopySoALostPrimaryFileStillSignsTheUserIn() {
        val token = "refresh-token-duplicate-copy-test"
        val auth = SecureAuthManager(context)
        auth.setSessionTokens("access-token-duplicate-copy-test", token)

        assertEquals(token, SecureAuthManager(context).refreshToken)
        assertNotEquals(
            token,
            context
                .getSharedPreferences("devtodo_secure_auth_fallback", Context.MODE_PRIVATE)
                .getString(AUTH_REFRESH_TOKEN_KEY, null),
        )

        // A damaged or temporarily unreadable AndroidX file must not sign the
        // device out while the Keystore copy still describes the same session.
        assertTrue(context.deleteSharedPreferences("devtodo_secure_auth"))
        val recovered = SecureAuthManager(context)
        assertEquals(token, recovered.refreshToken)
        assertEquals("access-token-duplicate-copy-test", recovered.accessToken)
    }

    private companion object {
        const val LEGACY_KEY = "devtodo_refresh-token"
    }
}
