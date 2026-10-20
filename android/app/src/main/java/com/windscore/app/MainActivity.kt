package com.windscore.app

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
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

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        webView = WebView(this)
        setContentView(webView)

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true      // localStorage（曲库名字、显示设置）
            databaseEnabled = true        // IndexedDB（曲库本体）
            allowFileAccess = false
            allowContentAccess = true
            mediaPlaybackRequiresUserGesture = false  // 播放页自动起伴奏
            cacheMode = WebSettings.LOAD_DEFAULT
            mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
        }

        val assetLoader = WebViewAssetLoader.Builder()
            .setDomain("appassets.androidplatform.net")
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView,
                request: WebResourceRequest,
            ): WebResourceResponse? = assetLoader.shouldInterceptRequest(request.url)

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

        if (savedInstanceState == null || webView.restoreState(savedInstanceState) == null) {
            // 首页 = 曲库
            webView.loadUrl("https://appassets.androidplatform.net/assets/library.html")
        }
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
    }

    override fun onBackPressed() {
        if (webView.canGoBack()) webView.goBack() else super.onBackPressed()
    }

    override fun onDestroy() {
        webView.destroy()
        super.onDestroy()
    }

    companion object {
        private const val FILE_CHOOSER_CODE = 1001
    }
}
