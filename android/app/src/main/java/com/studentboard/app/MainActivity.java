package com.studentboard.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.inputmethod.EditorInfo;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

/**
 * 学生状态管理系统 · 安卓壳
 *
 * 只有一块 WebView，业务全在服务端。壳内不放第二套界面：
 *  - 启动直接加载 SERVER_URL
 *  - 只允许该域名及其子域，其余链接交系统浏览器
 *  - SSL 错误一律 cancel，不提供「继续访问」
 *  - 返回键先回退历史，到根页再退出
 *  - 主文档加载失败显示内置重试页，不白屏
 *  - JS 桥只暴露 copyText(String)
 */
public class MainActivity extends Activity {

    /** 构建期可覆盖：-PserverUrl=...；为空则用 res/values/strings.xml 的 server_url */
    private static final String BUILD_SERVER_URL = BuildConfig.SERVER_URL;

    private static final String ERROR_PAGE_URL = "about:blank#student-board-error";
    private static final String RETRY_SCHEME = "studentboard";

    /** 壳设置：服务器地址存在 SharedPreferences 里，只在本机保存 */
    private static final String PREFS_NAME = "shell_settings";
    private static final String KEY_SERVER_URL = "server_url";

    /**
     * 注入到页面的剪贴板垫片：
     * 网页现有代码是 navigator.clipboard.writeText → execCommand('copy') 兜底；
     * 壳里 navigator.clipboard 依赖 WebView 的权限代理，未必可用，所以把
     * writeText 和 execCommand('copy') 都接到 NativeBridge.copyText（系统 ClipboardManager），
     * 网页侧不用改一行代码。
     */
    private static final String CLIPBOARD_SHIM_JS =
            "(function(){"
            + "if(!window.NativeBridge||!window.NativeBridge.copyText)return;"
            + "if(window.__sbClipboardShim)return;"
            + "window.__sbClipboardShim=true;"
            + "var orig=(navigator.clipboard&&navigator.clipboard.writeText)?"
            + "navigator.clipboard.writeText.bind(navigator.clipboard):null;"
            + "var bridge=function(t){"
            + "  return new Promise(function(resolve,reject){"
            + "    try{ if(typeof t!=='string'){ if(orig){ orig(t).then(resolve,reject); return; } "
            + "reject(new Error('unsupported')); return; }"
            + "      window.NativeBridge.copyText(t); resolve();"
            + "    }catch(e){ if(orig){ orig(t).then(resolve,reject); } else { reject(e); } }"
            + "  });"
            + "};"
            + "try{"
            + "  if(navigator.clipboard){ navigator.clipboard.writeText=bridge; }"
            + "  else{ Object.defineProperty(navigator,'clipboard',{value:{writeText:bridge},configurable:true}); }"
            + "}catch(e){"
            + "  try{ navigator.clipboard.writeText=bridge; }catch(e2){}"
            + "}"
            // execCommand('copy') 兜底也接到系统剪贴板
            + "var origExec=document.execCommand?document.execCommand.bind(document):null;"
            + "document.execCommand=function(cmd){"
            + "  if(String(cmd).toLowerCase()==='copy'){"
            + "    var t=''; var el=document.activeElement;"
            + "    if(el&&typeof el.value==='string'&&el.selectionStart!=null&&el.selectionEnd!=null){"
            + "      t=el.value.substring(el.selectionStart,el.selectionEnd); }"
            + "    if(!t&&window.getSelection){ var s=window.getSelection(); if(s) t=String(s.toString()); }"
            + "    if(t){ try{ window.NativeBridge.copyText(t); return true; }catch(e){} }"
            + "  }"
            + "  return origExec?origExec.apply(document,arguments):false;"
            + "};"
            + "})();";

    private FrameLayout rootLayout;
    private WebView webView;
    /** 首次启动 / 修改地址时的原生设置页（有值时盖在 WebView 上） */
    private View setupView;
    private EditText setupInput;
    private TextView setupError;
    /** 白名单根域名，形如 your-machine.your-tailnet.ts.net */
    private String baseHost = "";
    private String serverUrl = "";
    private boolean showingErrorPage = false;
    /** 这次导航是不是从错误页点「重试」发起的（用来清掉错误页历史） */
    private boolean retriedFromError = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        rootLayout = new FrameLayout(this);
        rootLayout.setBackgroundColor(Color.parseColor("#F6F7F9"));
        setContentView(rootLayout, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        // Android 15（API 35）对 targetSdk 35 强制 edge-to-edge，给内容让出状态栏/导航栏，
        // 否则页面顶部会被状态栏压住；低版本沿用系统默认的 fitSystemWindows，不做二次 padding。
        if (Build.VERSION.SDK_INT >= 35) {
            rootLayout.setOnApplyWindowInsetsListener((v, insets) -> {
                v.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                        insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
                return insets;
            });
            rootLayout.requestApplyInsets();
        }

        String saved = getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
                .getString(KEY_SERVER_URL, "");
        if (saved == null || saved.trim().isEmpty()) {
            // 首次启动：不直接 loadUrl，先让用户确认服务器地址
            showSetupPage(defaultServerUrl());
        } else {
            if (!applyServerUrl(saved)) {
                // 存了个坏值（极少见）：回设置页让用户改
                showSetupPage(defaultServerUrl());
            } else {
                createWebView();
                webView.loadUrl(serverUrl);
            }
        }
    }

    // ------------------------------------------------------------------
    // WebView 生命周期
    // ------------------------------------------------------------------

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    private void createWebView() {
        webView = new WebView(this);
        webView.setBackgroundColor(Color.parseColor("#F6F7F9"));
        webView.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setGeolocationEnabled(false);
        s.setSaveFormData(false);
        s.setSupportMultipleWindows(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setTextZoom(100);
        // 不做混合内容：https 页面里的 http 资源直接拦掉
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        // 便于服务端识别壳版本（可选用途）
        s.setUserAgentString(s.getUserAgentString() + " StudentStatusBoard/1.0.0");

        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            cm.setAcceptThirdPartyCookies(webView, false);
        }

        webView.addJavascriptInterface(new NativeBridge(this), "NativeBridge");

        webView.setWebViewClient(new ShellWebViewClient());
        webView.setWebChromeClient(new WebChromeClient());

        rootLayout.addView(webView);
    }

    @Override
    protected void onPause() {
        super.onPause();
        // 把 Cookie 落盘，保证 30 天会话在进程被杀后还在
        CookieManager.getInstance().flush();
        if (webView != null) webView.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
    }

    @Override
    protected void onDestroy() {
        CookieManager.getInstance().flush();
        destroyWebView();
        super.onDestroy();
    }

    private void destroyWebView() {
        if (webView == null) return;
        try {
            rootLayout.removeView(webView);
            webView.stopLoading();
            webView.setWebChromeClient(null);
            webView.setWebViewClient(null);
            webView.removeJavascriptInterface("NativeBridge");
            webView.loadUrl("about:blank");
            webView.destroy();
        } catch (Throwable ignored) {
            // 销毁失败不影响退出
        }
        webView = null;
    }

    // ------------------------------------------------------------------
    // 首次启动 / 修改地址的设置页（原生 View，不是 WebView）
    // ------------------------------------------------------------------

    private void showSetupPage(String prefill) {
        showingErrorPage = false;
        retriedFromError = false;
        destroyWebView();
        if (setupView != null) {
            rootLayout.removeView(setupView);
            setupView = null;
        }

        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setBackgroundColor(Color.parseColor("#F6F7F9"));

        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER_HORIZONTAL);
        box.setPadding(dp(24), dp(48), dp(24), dp(32));
        scroll.addView(box, new ScrollView.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        TextView title = new TextView(this);
        title.setText("连接服务器");
        title.setTextSize(24);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setTextColor(Color.parseColor("#111827"));
        box.addView(title, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        TextView desc = new TextView(this);
        desc.setText("手机需先连接 Tailscale；只支持 https:// 地址。\n地址形如 https://你的机器名.xxx.ts.net");
        desc.setTextSize(14);
        desc.setTextColor(Color.parseColor("#6B7280"));
        desc.setLineSpacing(dp(4), 1.0f);
        LinearLayout.LayoutParams descLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        descLp.topMargin = dp(10);
        box.addView(desc, descLp);

        setupInput = new EditText(this);
        setupInput.setHint("https://xxx.ts.net");
        setupInput.setText(prefill == null ? "" : prefill);
        setupInput.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        setupInput.setSingleLine(true);
        setupInput.setImeOptions(EditorInfo.IME_ACTION_GO);
        setupInput.setTextSize(16);
        setupInput.setSelectAllOnFocus(true);
        LinearLayout.LayoutParams inputLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        inputLp.topMargin = dp(20);
        box.addView(setupInput, inputLp);

        setupError = new TextView(this);
        setupError.setTextSize(13);
        setupError.setTextColor(Color.parseColor("#DC2626"));
        setupError.setVisibility(View.GONE);
        LinearLayout.LayoutParams errLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        errLp.topMargin = dp(8);
        box.addView(setupError, errLp);

        Button save = new Button(this);
        save.setText("保存并连接");
        save.setAllCaps(false);
        save.setTextSize(16);
        save.setTextColor(Color.WHITE);
        save.setBackgroundTintList(ColorStateList.valueOf(Color.parseColor("#2563EB")));
        LinearLayout.LayoutParams saveLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(52));
        saveLp.topMargin = dp(20);
        box.addView(save, saveLp);
        save.setOnClickListener(v -> saveAndConnect());
        setupInput.setOnEditorActionListener((v, actionId, event) -> {
            if (actionId == EditorInfo.IME_ACTION_GO || actionId == EditorInfo.IME_ACTION_DONE) {
                saveAndConnect();
                return true;
            }
            return false;
        });

        TextView tip = new TextView(this);
        tip.setText("地址只保存在本机。之后要改，可在加载失败页点「修改服务器地址」。");
        tip.setTextSize(12);
        tip.setTextColor(Color.parseColor("#9CA3AF"));
        LinearLayout.LayoutParams tipLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        tipLp.topMargin = dp(16);
        box.addView(tip, tipLp);

        setupView = scroll;
        rootLayout.addView(setupView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setupInput.requestFocus();
    }

    private void saveAndConnect() {
        if (setupInput == null) return;
        String raw = setupInput.getText().toString().trim();
        if (raw.isEmpty()) {
            showSetupError("请输入服务器地址");
            return;
        }
        String normalized = normalizeServerUrl(raw);
        if (normalized == null) {
            boolean looksHttp = raw.toLowerCase().startsWith("http://");
            showSetupError(looksHttp
                    ? "只支持 https:// 地址"
                    : "地址格式不对，例如 https://xxx.ts.net");
            return;
        }
        if (!applyServerUrl(normalized)) {
            showSetupError("地址格式不对，例如 https://xxx.ts.net");
            return;
        }
        getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
                .edit().putString(KEY_SERVER_URL, normalized).apply();
        hideSetupPage();
        destroyWebView();
        createWebView();
        webView.loadUrl(serverUrl);
    }

    private void hideSetupPage() {
        if (setupView != null) {
            rootLayout.removeView(setupView);
            setupView = null;
        }
        setupInput = null;
        setupError = null;
    }

    private void showSetupError(String message) {
        if (setupError == null) return;
        setupError.setText(message);
        setupError.setVisibility(View.VISIBLE);
    }

    private int dp(int value) {
        return Math.round(getResources().getDisplayMetrics().density * value);
    }

    // ------------------------------------------------------------------
    // 返回键：先回退，到根页再退出
    // ------------------------------------------------------------------

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            handleBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {
        // 手势返回（Android 13+ 已在 manifest 关掉 predictive back，走这条老路）
        if (!handleBack()) {
            super.onBackPressed();
        }
    }

    /** @return true 表示已消费返回事件 */
    private boolean handleBack() {
        if (setupView != null) {
            // 设置页上按返回 = 退出
            finish();
            return true;
        }
        if (showingErrorPage) {
            // 错误页上按返回 = 退出，不留空白壳
            finish();
            return true;
        }
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return true;
        }
        finish();
        return true;
    }

    // ------------------------------------------------------------------
    // 地址与白名单
    // ------------------------------------------------------------------

    /**
     * 默认地址优先级：BuildConfig.SERVER_URL（-PserverUrl 或 local.properties 的 serverUrl）
     * > res/values/strings.xml 的 server_url。
     * 已保存到 SharedPreferences 的值优先于这里，见 onCreate。
     */
    private String defaultServerUrl() {
        String url = BUILD_SERVER_URL == null ? "" : BUILD_SERVER_URL.trim();
        if (isPlaceholderUrl(url)) {
            String fallback = getString(R.string.server_url);
            fallback = fallback == null ? "" : fallback.trim();
            url = isPlaceholderUrl(fallback) ? "" : fallback;
        }
        return url;
    }

    private static boolean isPlaceholderUrl(String url) {
        if (url == null || url.trim().isEmpty()) return true;
        String lower = url.toLowerCase();
        return lower.contains("example.com")
                || lower.contains("your-machine")
                || lower.contains("your-tailnet")
                || url.contains("你的");
    }

    /** 校验并套用地址；返回 false 表示地址不合法 */
    private boolean applyServerUrl(String raw) {
        String normalized = normalizeServerUrl(raw);
        if (normalized == null) return false;
        serverUrl = normalized;
        Uri uri = Uri.parse(normalized);
        String host = uri.getHost();
        baseHost = host == null ? "" : host.toLowerCase();
        return !baseHost.isEmpty();
    }

    /**
     * 合法化规则：
     *  - 自动补 https://
     *  - 只接受 https
     *  - host 必须非空，且不能带空格
     * 返回 null = 不合法。
     */
    private String normalizeServerUrl(String raw) {
        if (raw == null) return null;
        String s = raw.trim();
        if (s.isEmpty() || s.matches(".*\\s.*")) return null;
        if (!s.matches("(?i)^[a-z][a-z0-9+.-]*://.*")) {
            s = "https://" + s;
        }
        try {
            java.net.URI uri = new java.net.URI(s);
            if (!"https".equalsIgnoreCase(uri.getScheme())) return null;
            String host = uri.getHost();
            if (host == null || host.trim().isEmpty()) return null;
        } catch (Exception e) {
            return null;
        }
        return s;
    }

    /** 只放行 https + 白名单域名（含子域） */
    private boolean isInternalUrl(Uri uri) {
        if (uri == null) return false;
        String scheme = uri.getScheme();
        if (scheme == null || !scheme.equalsIgnoreCase("https")) return false;
        String host = uri.getHost();
        if (host == null) return false;
        host = host.toLowerCase();
        if (baseHost.isEmpty()) return false;
        return host.equals(baseHost) || host.endsWith("." + baseHost);
    }

    private void openExternally(Uri uri) {
        try {
            Intent i = new Intent(Intent.ACTION_VIEW, uri);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(i);
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, "没有可打开该链接的应用", Toast.LENGTH_SHORT).show();
        }
    }

    // ------------------------------------------------------------------
    // WebViewClient
    // ------------------------------------------------------------------

    private class ShellWebViewClient extends WebViewClient {

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            return handleUrl(request.getUrl());
        }
        @SuppressWarnings("deprecation")
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            return handleUrl(Uri.parse(url));
        }

        private boolean handleUrl(Uri uri) {
            if (uri == null) return true;

            // 内置错误页的两个按钮：自定义 scheme，不额外开 JS 桥
            if (RETRY_SCHEME.equalsIgnoreCase(uri.getScheme())) {
                String action = uri.getHost();
                if ("setup".equalsIgnoreCase(action)) {
                    final String current = serverUrl;
                    // 不在 WebView 回调里直接 destroy，挪到下一帧
                    rootLayout.post(() -> showSetupPage(current));
                } else {
                    retryLoad();
                }
                return true;
            }

            if (isInternalUrl(uri)) {
                // 从错误页点重试链接触发的是正常 https 导航，这里把错误态清掉
                if (showingErrorPage) {
                    retriedFromError = true;
                    showingErrorPage = false;
                }
                return false; // 壳内加载
            }

            // 外链 / 非 https / 其他 scheme 一律交系统
            openExternally(uri);
            return true;
        }

        @Override
        public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
            // 自签、过期、域名不匹配：一律拒绝，不给「继续」的余地
            handler.cancel();
            String host = error != null && error.getUrl() != null
                    ? Uri.parse(error.getUrl()).getHost() : "";
            Toast.makeText(MainActivity.this,
                    "证书校验失败，已阻止连接" + (host == null || host.isEmpty() ? "" : "：" + host),
                    Toast.LENGTH_LONG).show();
            showErrorPage("TLS_CERT_INVALID", "证书校验未通过，已拒绝连接");
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request == null || !request.isForMainFrame()) return;
            if (request.getUrl() != null && "about".equals(request.getUrl().getScheme())) return;
            CharSequence desc = (error != null) ? error.getDescription() : "";
            int code = (error != null) ? error.getErrorCode() : -1;
            showErrorPage(String.valueOf(code), desc == null ? "" : desc.toString());
        }

        @SuppressWarnings("deprecation")
        @Override
        public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) return; // 新回调已处理
            showErrorPage(String.valueOf(errorCode), description == null ? "" : description);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            super.onPageFinished(view, url);
            if (url != null && url.startsWith("http")) {
                boolean wasError = retriedFromError;
                retriedFromError = false;
                showingErrorPage = false;
                // 从重试页回来时把错误页从历史里清掉，避免按返回又退回错误页
                if (wasError) view.clearHistory();
                // 页面就绪后装上剪贴板垫片（SPA 路由切换不影响，垫片改的是 navigator 本身）
                view.evaluateJavascript(CLIPBOARD_SHIM_JS, null);
            }
        }

        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            // 渲染进程崩溃：重建 WebView 并回到首页，避免整个 App 被杀
            destroyWebView();
            createWebView();
            if (webView != null) webView.loadUrl(serverUrl);
            return true;
        }
    }

    // ------------------------------------------------------------------
    // 失败重试页（内置 HTML，不联网、不白屏）
    // ------------------------------------------------------------------

    private void retryLoad() {
        if (showingErrorPage) retriedFromError = true;
        showingErrorPage = false;
        if (webView == null) {
            createWebView();
        }
        if (webView != null) {
            webView.loadUrl(serverUrl);
        }
    }

    private void showErrorPage(String code, String description) {
        if (showingErrorPage) return; // 避免 SSL 错误 + onReceivedError 连续回调时反复重载
        showingErrorPage = true;
        final String html = buildErrorHtml(code, description);
        if (webView == null) return;
        // 在回调里直接 loadData 可能被当前导航覆盖，post 到下一帧更稳
        webView.post(() -> {
            if (webView != null) {
                webView.loadDataWithBaseURL(null, html, "text/html", "UTF-8", ERROR_PAGE_URL);
            }
        });
    }

    private String buildErrorHtml(String code, String description) {
        String safeHost = escapeHtml(serverUrl);
        String safeDesc = escapeHtml(description == null ? "" : description);
        String safeCode = escapeHtml(code == null ? "" : code);
        return "<!DOCTYPE html><html lang=\"zh-CN\"><head>"
                + "<meta charset=\"utf-8\">"
                + "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\">"
                + "<title>页面没打开</title><style>"
                + "*{box-sizing:border-box}"
                + "html,body{margin:0;height:100%}"
                + "body{display:flex;align-items:center;justify-content:center;padding:24px;"
                + "background:#F6F7F9;color:#1F2937;"
                + "font-family:-apple-system,'Noto Sans SC','PingFang SC','Microsoft YaHei',sans-serif}"
                + ".card{width:100%;max-width:420px;background:#fff;border-radius:16px;padding:28px 24px;"
                + "box-shadow:0 8px 28px rgba(17,24,39,.08);text-align:center}"
                + ".dot{width:48px;height:48px;margin:0 auto 16px;border-radius:24px;"
                + "background:#FEF2F2;color:#DC2626;font-size:26px;line-height:48px}"
                + "h1{font-size:19px;margin:0 0 8px;font-weight:600}"
                + "p{font-size:14px;line-height:1.6;color:#6B7280;margin:0 0 18px}"
                + ".host{display:block;font-size:12px;color:#9CA3AF;word-break:break-all;margin-bottom:18px}"
                + "a.btn{display:block;padding:13px 0;border-radius:12px;background:#2563EB;color:#fff;"
                + "font-size:15px;font-weight:600;text-decoration:none}"
                + "a.btn:active{background:#1E40AF}"
                + "a.btn.secondary{margin-top:10px;background:#fff;color:#2563EB;border:1px solid #DBEAFE}"
                + "a.btn.secondary:active{background:#EFF6FF}"
                + ".meta{margin-top:16px;font-size:11px;color:#C3C8D0;word-break:break-all}"
                + "</style></head><body><div class=\"card\">"
                + "<div class=\"dot\">!</div>"
                + "<h1>页面没打开</h1>"
                + "<p>检查手机网络，或确认电脑端服务和 Tailscale 正在运行</p>"
                + "<span class=\"host\">" + safeHost + "</span>"
                + "<a class=\"btn\" href=\"" + safeHost + "\">重试</a>"
                + "<a class=\"btn secondary\" href=\"" + RETRY_SCHEME + "://setup\">修改服务器地址</a>"
                + "<div class=\"meta\">" + safeCode
                + (safeDesc.isEmpty() ? "" : " · " + safeDesc) + "</div>"
                + "</div></body></html>";
    }

    private static String escapeHtml(String raw) {
        if (raw == null) return "";
        return raw.replace("&", "&amp;")
                .replace("<", "&lt;")
                .replace(">", "&gt;")
                .replace("\"", "&quot;")
                .replace("'", "&#39;");
    }

    // ------------------------------------------------------------------
    // JS 桥：只有 copyText 一个方法
    // ------------------------------------------------------------------

    static class NativeBridge {
        private final Activity activity;

        NativeBridge(Activity activity) {
            this.activity = activity;
        }

        @JavascriptInterface
        public void copyText(String text) {
            if (text == null || text.isEmpty()) return;
            final Activity act = activity;
            act.runOnUiThread(() -> {
                ClipboardManager cm = (ClipboardManager)
                        act.getSystemService(Context.CLIPBOARD_SERVICE);
                if (cm == null) return;
                cm.setPrimaryClip(ClipData.newPlainText("家长反馈", text));
                Toast.makeText(act, "已复制，可直接发给家长", Toast.LENGTH_SHORT).show();
            });
        }
    }
}
