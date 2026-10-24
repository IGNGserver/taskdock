package com.devtodo.app.data.remote

import okhttp3.Call
import okhttp3.EventListener
import okhttp3.Handshake
import okhttp3.Protocol
import okhttp3.Response
import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Proxy

/** No URLs, query strings, credentials, response text or server error messages. */
internal class NetworkTrace(private val emit: (String) -> Unit) : EventListener() {
    private val started = System.nanoTime()
    private var dnsStart = 0L
    private var connectStart = 0L
    private var tlsStart = 0L
    private var dnsMs = 0L
    private var connectMs = 0L
    private var tlsMs = 0L
    private var headersMs = 0L
    private var wireBytes = 0L
    private var status = 0
    private var encoding = "identity"
    private var requestId = ""
    private var reused = true
    private fun elapsed(since: Long) = (System.nanoTime() - since) / 1_000_000

    override fun dnsStart(call: Call, domainName: String) { dnsStart = System.nanoTime() }
    override fun dnsEnd(call: Call, domainName: String, inetAddressList: List<InetAddress>) { dnsMs += elapsed(dnsStart) }
    override fun connectStart(call: Call, inetSocketAddress: InetSocketAddress, proxy: Proxy) {
        reused = false
        connectStart = System.nanoTime()
    }
    override fun secureConnectStart(call: Call) { tlsStart = System.nanoTime() }
    override fun secureConnectEnd(call: Call, handshake: Handshake?) { tlsMs += elapsed(tlsStart) }
    override fun connectEnd(call: Call, inetSocketAddress: InetSocketAddress, proxy: Proxy, protocol: Protocol?) { connectMs += elapsed(connectStart) }
    override fun responseHeadersEnd(call: Call, response: Response) {
        headersMs = elapsed(started)
        status = response.code
        encoding = response.header("Content-Encoding").takeIf { it in setOf("gzip", "zstd", "br") } ?: "identity"
        requestId = response.header("X-Request-Id").orEmpty().take(128).filter { it.isLetterOrDigit() || it == '-' }
    }
    override fun responseBodyEnd(call: Call, byteCount: Long) { wireBytes += byteCount }
    override fun callEnd(call: Call) = report(call, "ok")
    override fun callFailed(call: Call, ioe: IOException) = report(call, if (call.isCanceled()) "cancelled" else "io")

    private fun report(call: Call, outcome: String) {
        val path = call.request().url.encodedPath
        val route = when {
            path.startsWith("/api/v2/sync/bootstrap/") -> "sync.page"
            path == "/api/v2/sync/bootstrap" -> "sync.bootstrap"
            path == "/api/v2/sync/pull" -> "sync.pull"
            path == "/api/v2/sync/push" -> "sync.push"
            path == "/api/v2/sync/preview" -> "sync.preview"
            path == "/api/v2/tree/children" -> "directory"
            path.startsWith("/api/v2/tasks/") -> "task"
            path.startsWith("/api/v1/auth/") -> "auth"
            path.endsWith("/ws") -> "realtime"
            else -> "other"
        }
        emit("route=$route outcome=$outcome status=$status dnsMs=$dnsMs connectMs=$connectMs tlsMs=$tlsMs headersMs=$headersMs totalMs=${elapsed(started)} wireBytes=$wireBytes encoding=$encoding reused=$reused requestId=$requestId")
    }
}
