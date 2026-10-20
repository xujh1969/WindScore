package com.windscore.app

import android.content.Context
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.InputStream
import java.net.Inet4Address

/** 仅绑定 Wi-Fi 的私有 IPv4；通知栏服务允许切去发送地址，入库在页面前台消费。 */
class LanUploadController(private val context: Context, private val onRunningChanged: () -> Unit) {
    private val connectivity = context.getSystemService(ConnectivityManager::class.java)
    @Volatile private var server: LanUploadServer? = null
    @Volatile var foreground = false
        set(value) { field = value; server?.foreground = value }
    private var address = ""
    private var url = ""
    private var message = "服务未启动"
    private val cache = File(context.cacheDir, "lan-upload")
    val running: Boolean get() = server?.active == true

    private val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onLost(network: Network) { checkNetwork() }
        override fun onLinkPropertiesChanged(network: Network, properties: LinkProperties) { checkNetwork() }
    }

    init {
        cache.mkdirs()
        cache.listFiles()?.forEach { it.delete() }
        connectivity.registerNetworkCallback(NetworkRequest.Builder().addTransportType(NetworkCapabilities.TRANSPORT_WIFI).build(), callback)
    }

    private fun wifiAddress(): String? = connectivity.allNetworks.firstNotNullOfOrNull { network ->
        val caps = connectivity.getNetworkCapabilities(network)
        if (caps?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) != true) null
        else connectivity.getLinkProperties(network)?.linkAddresses?.map { it.address }
            ?.firstOrNull { it is Inet4Address && it.isSiteLocalAddress && !it.isLoopbackAddress }?.hostAddress
    }

    @Synchronized private fun checkNetwork() {
        if (running && wifiAddress() != address) stop("无线局域网已断开或地址变化，请重新启动服务")
    }

    @Synchronized fun start(): String {
        if (running) return status()
        if (!foreground) { message = "请让 WindScore 保持在前台后启动服务"; return status() }
        val ip = wifiAddress()
        if (ip == null) { message = "请连接无线局域网，不能通过移动数据或公网启动上传服务"; return status() }
        try {
            val page = { context.assets.open("windscore-upload.html").bufferedReader().use { it.readText() } }
            var candidate = LanUploadServer(ip, 8080, cache, page)
            try { candidate.start(30_000, false) } catch (_: Exception) {
                candidate.shutdown("端口已占用")
                candidate = LanUploadServer(ip, 0, cache, page)
                candidate.start(30_000, false)
            }
            address = ip; url = "http://$ip:${candidate.listeningPort}/windscore?key=${candidate.token}"
            candidate.foreground = foreground
            server = candidate; message = "服务已启动，等待电脑连接"
            onRunningChanged()
        } catch (_: Exception) {
            message = "服务无法启动，请检查无线局域网连接或网络权限"
        }
        return status()
    }

    @Synchronized fun stop(reason: String = "上传服务已停用"): String {
        server?.shutdown(reason)
        url = ""; message = reason; onRunningChanged()
        return status()
    }

    @Synchronized fun status(): String {
        checkNetwork()
        val state = server?.snapshot() ?: JSONObject().put("running", false).put("connected", false).put("connectedBefore", false).put("jobs", JSONArray())
        state.put("url", if (running) url else "")
        state.put("foreground", foreground)
        if (!running) state.put("message", message)
        return state.toString()
    }

    fun takeNext(): String = if (foreground) server?.takeNext()?.toString() ?: "null" else "null"
    fun isImportActive(id: String): Boolean = server?.isImportActive(id) == true
    fun openFile(id: String): InputStream? = server?.openFile(id)
    fun complete(result: String) {
        try {
            val json = JSONObject(result)
            server?.complete(json.getString("id"), json.optString("song"), json.optString("error"))
        } catch (_: Exception) { /* 无效回写不能改变任务 */ }
    }
    fun destroy() {
        stop("应用已退出，上传服务已停用")
        connectivity.unregisterNetworkCallback(callback)
    }
}
