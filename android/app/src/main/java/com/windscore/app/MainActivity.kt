package com.windscore.app

import android.app.Activity
import android.Manifest
import android.content.pm.PackageManager
import android.content.Intent
import android.content.ClipData
import android.content.ClipboardManager
import android.net.Uri
import android.os.Bundle
import android.os.Build
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.webkit.JavascriptInterface
import android.view.WindowManager
import android.widget.Toast
import androidx.webkit.WebViewAssetLoader

/**
 * WindScore 安卓壳：一个全屏 WebView 加载打进 assets 的 web 版 WindScore。
 *
 * 资源经 WebViewAssetLoader 映射到 https://appassets.androidplatform.net/assets/…
 * （用 https 源而不是 file://，ES 模块、IndexedDB、localStorage 才能正常工作）。
 * web 端以这个域名识别「安卓 App 环境」，自动隐藏编辑器 / 对轨入口。
 *
 * 「导入打包」走页面里现成的 <input type="file">，由 onShowFileChooser
 * 桥接到系统文件选择器；「打包导出」的下载由 DownloadListener 交给系统处理。
 */
class MainActivity : Activity() {

    private lateinit var webView: WebView
    private var filePathCallback: android.webkit.ValueCallback<Array<Uri>>? = null
    private var playbackActive = false
    private var foreground = false
    private lateinit var uploads: LanUploadController
    private val appBuild: Long get() = packageManager.getPackageInfo(packageName, 0).longVersionCode
    private val entryUrl: String get() = "$ANDROID_ENTRY?build=$appBuild"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        uploads = LanUploadController(this) { runOnUiThread {
            updateKeepScreenOn()
            if (uploads.running) {
                LanUploadService.controller = uploads
                startForegroundService(Intent(this, LanUploadService::class.java))
                if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                    requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1002)
                }
            } else stopService(Intent(this, LanUploadService::class.java))
        } }
        webView = WebView(this)
        setContentView(webView)
        webView.addJavascriptInterface(object {
            @JavascriptInterface fun getAppBuildInfo(): String {
                val info = packageManager.getPackageInfo(packageName, 0)
                return "${info.versionName} · 构建 ${info.longVersionCode}"
            }
            @JavascriptInterface fun startUploadService(): String = uploads.start()
            @JavascriptInterface fun stopUploadService(): String = uploads.stop()
            @JavascriptInterface fun getUploadServiceStatus(): String = uploads.status()
            @JavascriptInterface fun copyUploadAddress(): Boolean = try {
                val url = org.json.JSONObject(uploads.status()).optString("url")
                if (url.isEmpty()) false else {
                    getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("WindScore 曲库上传地址", url))
                    true
                }
            } catch (_: Exception) { false }
            @JavascriptInterface fun takeNextUpload(): String = uploads.takeNext()
            @JavascriptInterface fun isUploadActive(id: String): Boolean = uploads.isImportActive(id)
            @JavascriptInterface fun completeUpload(result: String) = uploads.complete(result)
            @JavascriptInterface
            fun setPlaybackActive(active: Boolean) {
                runOnUiThread {
                    playbackActive = active
                    updateKeepScreenOn()
                }
            }
        }, "WindScoreAndroid")

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true      // localStorage（曲库名字、显示设置）
            databaseEnabled = true        // IndexedDB（曲库本体）
            allowFileAccess = false
            allowContentAccess = true
            mediaPlaybackRequiresUserGesture = false  // 播放页自动起伴奏
            cacheMode = WebSettings.LOAD_DEFAULT
            mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
            // 谱面双指手势只改变字号，不叠加 WebView 的网页缩放。
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
        }

        val assetLoader = WebViewAssetLoader.Builder()
            .setDomain("appassets.androidplatform.net")
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView,
                request: WebResourceRequest,
            ): WebResourceResponse? {
                if (request.url.scheme == "https" && request.url.host == "appassets.androidplatform.net" && request.url.path?.startsWith("/lan-upload/") == true) {
                    val stream = uploads.openFile(request.url.lastPathSegment ?: "")
                    return WebResourceResponse("application/octet-stream", null, if (stream != null) 200 else 404,
                        if (stream != null) "OK" else "Not Found", mapOf("Cache-Control" to "no-store"), stream)
                }
                return assetLoader.shouldInterceptRequest(request.url)
            }

            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: WebResourceRequest,
            ): Boolean {
                val url = request.url
                // 站内放行；外部链接（帮助里的联系方式等）交给系统浏览器
                if (url.host == "appassets.androidplatform.net") return false
                return try {
                    startActivity(Intent(Intent.ACTION_VIEW, url))
                    true
                } catch (_: Exception) {
                    true
                }
            }
        }

        // web 端「打包」导出触发下载：交给系统下载器（通知栏可见）
        webView.setDownloadListener { url, _, _, _, _ ->
            try {
                startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
            } catch (_: Exception) {
                Toast.makeText(this, "下载失败：$url", Toast.LENGTH_SHORT).show()
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                view: WebView,
                callback: android.webkit.ValueCallback<Array<Uri>>,
                params: FileChooserParams,
            ): Boolean {
                filePathCallback?.onReceiveValue(null)
                filePathCallback = callback
                return try {
                    startActivityForResult(params.createIntent(), FILE_CHOOSER_CODE)
                    true
                } catch (_: Exception) {
                    filePathCallback = null
                    false
                }
            }
        }

        // 更新 APK 后不恢复旧版 play.html/editor.html 历史；入口加构建号避开旧 HTML 缓存。
        val restored = if (savedInstanceState?.getLong(STATE_BUILD, -1) == appBuild) webView.restoreState(savedInstanceState) else null
        val restoredUrl = restored?.currentItem?.url?.let { Uri.parse(it) }
        val validEntry = restoredUrl?.let { it.scheme == "https" && it.host == "appassets.androidplatform.net" && it.path == "/assets/android.html" } == true
        if (!validEntry) webView.loadUrl(entryUrl)
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode == FILE_CHOOSER_CODE) {
            val callback = filePathCallback
            filePathCallback = null
            callback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data))
        } else {
            super.onActivityResult(requestCode, resultCode, data)
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
        outState.putLong(STATE_BUILD, appBuild)
    }

    private fun updateKeepScreenOn() {
        if ((playbackActive || uploads.running) && foreground) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }

    override fun onResume() {
        super.onResume()
        foreground = true
        uploads.foreground = true
        updateKeepScreenOn()
    }

    override fun onPause() {
        foreground = false
        uploads.foreground = false
        updateKeepScreenOn()
        super.onPause()
    }

    override fun onBackPressed() {
        webView.evaluateJavascript("""
            (() => {
                const dialog = document.querySelector('dialog[open]');
                if (!dialog) return false;
                dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
                return true;
            })()
        """.trimIndent()) { handled ->
            if (handled != "true") {
                if (webView.canGoBack()) webView.goBack() else finish()
            }
        }
    }

    override fun onDestroy() {
        uploads.destroy()
        webView.destroy()
        super.onDestroy()
    }

    companion object {
        private const val FILE_CHOOSER_CODE = 1001
        private const val STATE_BUILD = "windscore.android.build"
        private const val ANDROID_ENTRY = "https://appassets.androidplatform.net/assets/android.html"
    }
}
