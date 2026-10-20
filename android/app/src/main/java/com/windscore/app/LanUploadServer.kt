package com.windscore.app

import fi.iki.elonen.NanoHTTPD
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.InputStream
import java.util.UUID

/** 只接收已声明的文件；曲库入库由 WebView 完成后回写最终结果。 */
class LanUploadServer(
    host: String,
    port: Int,
    private val directory: File,
    private val page: () -> String,
) : NanoHTTPD(host, port) {
    val token: String = UUID.randomUUID().toString()
    @Volatile var foreground = true
    private data class Job(
        val id: String, val name: String, val size: Long,
        var state: String = "waiting", var received: Long = 0,
        var song: String = "", var error: String = "",
    )
    private val jobs = mutableListOf<Job>()
    @Volatile var active = true
        private set
    private var lastHeartbeat = 0L
    private var lastActivity = System.currentTimeMillis()
    private var connectedBefore = false
    private var message = "服务已启动，等待电脑连接"

    init { directory.mkdirs() }

    @Synchronized fun snapshot(): JSONObject {
        if (active && System.currentTimeMillis() - lastActivity > 120_000) {
            jobs.filter { it.state == "waiting" || it.state == "receiving" }.forEach {
                it.state = "error"; it.error = "传输超时，请重新上传"; file(it.id).delete()
            }
        }
        val connected = active && System.currentTimeMillis() - lastHeartbeat < 15_000
        val items = JSONArray()
        jobs.forEach { job -> items.put(JSONObject().put("id", job.id).put("name", job.name).put("size", job.size)
            .put("state", job.state).put("received", job.received).put("song", job.song).put("error", job.error)) }
        return JSONObject().put("running", active).put("connected", connected).put("connectedBefore", connectedBefore)
            .put("message", message).put("foreground", foreground).put("jobs", items)
    }

    @Synchronized fun takeNext(): JSONObject? {
        if (!active || jobs.any { it.state == "importing" }) return null
        val next = jobs.firstOrNull { it.state == "queued" } ?: return null
        next.state = "importing"
        return JSONObject().put("id", next.id).put("name", next.name)
    }

    @Synchronized fun isImportActive(id: String): Boolean = active && jobs.any { it.id == id && it.state == "importing" }

    @Synchronized fun openFile(id: String): InputStream? {
        if (!isImportActive(id)) return null
        return try { FileInputStream(file(id)) } catch (_: Exception) { null }
    }

    @Synchronized fun complete(id: String, song: String, error: String) {
        val job = jobs.firstOrNull { it.id == id && it.state == "importing" } ?: return
        if (!active) return
        job.song = song.take(256); job.error = error.take(500)
        job.state = if (error.isEmpty() && song.isNotEmpty()) "success" else "error"
        file(id).delete()
    }

    fun shutdown(reason: String) {
        synchronized(this) {
            active = false; message = reason
            jobs.filter { it.state != "success" && it.state != "error" }.forEach {
                it.state = "error"; it.error = reason
            }
        }
        stop()
        directory.listFiles()?.forEach { it.delete() }
    }

    private fun file(id: String) = File(directory, "$id.wspack")
    private fun reply(status: Response.Status, data: JSONObject): Response = secure(newFixedLengthResponse(status, "application/json; charset=utf-8", data.toString()))
    private fun fail(status: Response.Status, text: String) = reply(status, JSONObject().put("error", text))
    private fun secure(response: Response): Response {
        response.addHeader("Cache-Control", "no-store")
        response.addHeader("Referrer-Policy", "no-referrer")
        response.addHeader("X-Content-Type-Options", "nosniff")
        response.addHeader("Content-Security-Policy", "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
        response.closeConnection(true)
        return response
    }

    override fun serve(session: IHTTPSession): Response {
        if (!active) return fail(Response.Status.SERVICE_UNAVAILABLE, "上传服务已停用")
        val supplied = session.headers["x-windscore-token"] ?: session.parameters["key"]?.firstOrNull()
        if (supplied != token) return fail(Response.Status.FORBIDDEN, "连接地址已失效，请复制手机上的完整地址")
        // 浏览器跨站请求不能借由手机监听端口提交文件。
        val origin = session.headers["origin"]
        if (origin != null && origin != "http://${session.headers["host"]}") return fail(Response.Status.FORBIDDEN, "不允许跨站上传")
        return try {
            when {
                session.method == Method.GET && (session.uri == "/windscore" || session.uri == "/windscore/") -> secure(newFixedLengthResponse(Response.Status.OK, "text/html; charset=utf-8", page()))
                session.method == Method.POST && session.uri == "/api/heartbeat" -> {
                    synchronized(this) { lastHeartbeat = System.currentTimeMillis(); connectedBefore = true }
                    reply(Response.Status.OK, snapshot())
                }
                session.method == Method.GET && session.uri == "/api/status" -> reply(Response.Status.OK, snapshot())
                session.method == Method.POST && session.uri == "/api/batch" -> createBatch(session)
                session.method == Method.PUT && session.uri.startsWith("/api/upload/") -> receive(session, session.uri.substringAfterLast('/'))
                session.method == Method.POST && session.uri == "/api/cancel" -> {
                    synchronized(this) {
                        jobs.filter { it.state == "waiting" || it.state == "receiving" }.forEach {
                            it.state = "error"; it.error = "电脑已取消本次传输"; file(it.id).delete()
                        }
                    }
                    reply(Response.Status.OK, snapshot())
                }
                else -> fail(Response.Status.NOT_FOUND, "页面不存在")
            }
        } catch (_: Exception) {
            fail(Response.Status.BAD_REQUEST, "请求无效或接收失败，请重新上传")
        }
    }

    private fun readJson(session: IHTTPSession): JSONObject {
        val length = session.headers["content-length"]?.toIntOrNull() ?: throw IllegalArgumentException()
        require(length in 1..16_384)
        val bytes = ByteArray(length)
        var offset = 0
        while (offset < length) {
            val read = session.inputStream.read(bytes, offset, length - offset)
            require(read > 0); offset += read
        }
        return JSONObject(String(bytes, Charsets.UTF_8))
    }

    private fun createBatch(session: IHTTPSession): Response {
        val files = readJson(session).optJSONArray("files") ?: return fail(Response.Status.BAD_REQUEST, "请选择乐谱包")
        return synchronized(this) { createBatch(files) }
    }

    private fun createBatch(files: JSONArray): Response {
        if (files.length() !in 1..9) return fail(Response.Status.BAD_REQUEST, "每批只能上传 1～9 个文件")
        if (jobs.any { it.state != "success" && it.state != "error" }) return fail(Response.Status.CONFLICT, "手机正在处理上一批文件，请稍候")
        val batch = mutableListOf<Job>()
        var total = 0L
        for (i in 0 until files.length()) {
            val item = files.getJSONObject(i)
            val name = item.optString("name")
            val size = item.optLong("size", -1)
            if (!name.endsWith(".wspack", true) || name.length !in 1..255 || name.contains('/') || name.contains('\\')) return fail(Response.Status.BAD_REQUEST, "只接收 .wspack 乐谱包")
            if (size !in 1..MAX_FILE) return fail(Response.Status.BAD_REQUEST, "单文件不能超过 100 MiB，且不能为空")
            total += size
            batch.add(Job(UUID.randomUUID().toString(), name, size))
        }
        if (total > MAX_BATCH) return fail(Response.Status.BAD_REQUEST, "每批文件总大小不能超过 500 MiB")
        if (!active) return fail(Response.Status.SERVICE_UNAVAILABLE, "上传服务已停用")
        directory.listFiles()?.forEach { it.delete() }
        jobs.clear(); jobs.addAll(batch); lastActivity = System.currentTimeMillis()
        return reply(Response.Status.OK, snapshot())
    }

    private fun receive(session: IHTTPSession, id: String): Response {
        val job: Job
        synchronized(this) {
            job = jobs.firstOrNull { it.id == id } ?: return fail(Response.Status.NOT_FOUND, "上传任务不存在")
            if (job.state != "waiting" || jobs.any { it.state == "receiving" }) return fail(Response.Status.CONFLICT, "请按顺序上传文件")
            if (session.headers["content-length"]?.toLongOrNull() != job.size) return fail(Response.Status.BAD_REQUEST, "文件长度与声明不一致")
            if (directory.usableSpace < job.size + 10 * 1024 * 1024) return fail(Response.Status.BAD_REQUEST, "手机存储空间不足")
            job.state = "receiving"; lastActivity = System.currentTimeMillis()
        }
        try {
            file(id).outputStream().use { output ->
                val buffer = ByteArray(32 * 1024)
                var received = 0L
                while (received < job.size) {
                    synchronized(this) { check(active && job.state == "receiving") }
                    val read = session.inputStream.read(buffer, 0, minOf(buffer.size.toLong(), job.size - received).toInt())
                    check(read > 0)
                    output.write(buffer, 0, read); received += read
                    synchronized(this) { job.received = received; lastActivity = System.currentTimeMillis() }
                }
            }
            synchronized(this) {
                check(active && job.state == "receiving")
                job.state = "queued"
            }
            return reply(Response.Status.OK, snapshot())
        } catch (_: Exception) {
            synchronized(this) { job.state = "error"; job.error = if (active) "文件接收中断，请重新上传" else message }
            file(id).delete()
            return fail(Response.Status.BAD_REQUEST, "文件接收中断")
        }
    }

    companion object {
        const val MAX_FILE = 100L * 1024 * 1024
        const val MAX_BATCH = 500L * 1024 * 1024
    }
}
