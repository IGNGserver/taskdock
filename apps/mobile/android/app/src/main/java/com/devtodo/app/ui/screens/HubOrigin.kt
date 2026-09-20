package com.devtodo.app.ui.screens

import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

internal fun normalizedHubOrigin(input: String): String? {
    val url = input.trim().toHttpUrlOrNull() ?: return null
    if (
        url.username.isNotEmpty() ||
            url.password.isNotEmpty() ||
            url.encodedPath != "/" ||
            url.query != null ||
            url.fragment != null
    )
        return null
    return url.toString().trimEnd('/')
}
