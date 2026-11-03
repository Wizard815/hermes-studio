package com.ekkostudio.own

import android.annotation.SuppressLint
import android.content.Context
import android.os.Bundle
import android.text.InputType
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity

/**
 * Shell around the Studio web app. The first run asks for the server URL (for
 * example the Cloudflare tunnel address); after that the WebView loads it and the
 * normal Studio login applies.
 */
class MainActivity : AppCompatActivity() {
    private var webView: WebView? = null

    private val prefs get() = getSharedPreferences("studio_own", Context.MODE_PRIVATE)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val saved = prefs.getString(KEY_SERVER_URL, null)
        if (saved.isNullOrBlank()) showSetup() else showWebView(saved)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val view = webView
                if (view != null && view.canGoBack()) view.goBack() else finish()
            }
        })
    }

    private fun showSetup() {
        val pad = (16 * resources.displayMetrics.density).toInt()
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad * 3, pad, pad)
        }
        val title = TextView(this).apply {
            text = "Connect to your Studio server"
            textSize = 20f
        }
        val input = EditText(this).apply {
            hint = "https://studio.example.com"
            inputType = InputType.TYPE_TEXT_VARIATION_URI
            tag = "server_url"
            setSingleLine()
        }
        val button = Button(this).apply {
            text = "Connect"
            tag = "connect"
            setOnClickListener {
                val url = normalizeUrl(input.text.toString())
                if (url == null) {
                    input.error = "Enter a full http(s) address"
                } else {
                    prefs.edit().putString(KEY_SERVER_URL, url).apply()
                    showWebView(url)
                }
            }
        }
        layout.addView(title)
        layout.addView(input, ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        layout.addView(button)
        setContentView(layout)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun showWebView(url: String) {
        val view = WebView(this).apply {
            tag = "studio_webview"
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
            webViewClient = WebViewClient()
            webChromeClient = WebChromeClient()
        }
        CookieManager.getInstance().setAcceptThirdPartyCookies(view, true)
        webView = view
        setContentView(view)
        view.loadUrl(url)
    }

    override fun onDestroy() {
        webView?.destroy()
        webView = null
        super.onDestroy()
    }

    companion object {
        private const val KEY_SERVER_URL = "server_url"

        /** Accepts only absolute http(s) URLs; returns null for anything else. */
        fun normalizeUrl(raw: String): String? {
            val trimmed = raw.trim().trimEnd('/')
            if (!(trimmed.startsWith("http://") || trimmed.startsWith("https://"))) return null
            val host = trimmed.substringAfter("://").substringBefore('/')
            return if (host.isBlank()) null else trimmed
        }
    }
}
