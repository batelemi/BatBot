package com.batbot.app;

import android.app.Activity;
import android.os.Bundle;
import android.content.Intent;
import android.content.ClipData;
import android.content.ActivityNotFoundException;
import android.net.Uri;
import android.webkit.WebChromeClient;
import android.webkit.ValueCallback;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient.FileChooserParams;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebSettings;
import android.webkit.WebResourceRequest;
import android.os.Message;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.widget.Toast;

public class MainActivity extends Activity {

    private WebView webView;
    private ValueCallback<Uri[]> filePathCallback;
    private Uri selectedCaptureUri;
    private static final int FILE_CHOOSER_REQUEST_CODE = 7401;

    public class AndroidBridge {
        @JavascriptInterface
        public void shareCapture(final String platform, final String message) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    shareWithPlatform(platform, message, true);
                }
            });
        }

        @JavascriptInterface
        public void shareText(final String platform, final String message) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    shareWithPlatform(platform, message, false);
                }
            });
        }
    }

    private void shareWithPlatform(String platform, String message, boolean includeImage) {
        Uri imageUri = includeImage ? selectedCaptureUri : null;

        if (includeImage && imageUri == null) {
            Toast.makeText(this, "Aucune capture sélectionnée. Réessayez.", Toast.LENGTH_LONG).show();
            return;
        }

        Intent intent = new Intent(Intent.ACTION_SEND);
        intent.putExtra(Intent.EXTRA_TEXT, message);

        if (imageUri != null) {
            intent.setType("image/*");
            intent.putExtra(Intent.EXTRA_STREAM, imageUri);
            intent.setClipData(ClipData.newUri(getContentResolver(), "Capture BATBOT PRO", imageUri));
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        } else {
            intent.setType("text/plain");
        }

        String packageName = "whatsapp".equalsIgnoreCase(platform)
            ? "com.whatsapp"
            : "org.telegram.messenger";

        try {
            intent.setPackage(packageName);
            startActivity(intent);
        } catch (ActivityNotFoundException e) {
            intent.setPackage(null);
            try {
                startActivity(Intent.createChooser(intent,
                    "whatsapp".equalsIgnoreCase(platform)
                        ? "Partager avec WhatsApp"
                        : "Partager avec Telegram"));
            } catch (Exception error) {
                Toast.makeText(this, "Impossible d'ouvrir le partage.", Toast.LENGTH_LONG).show();
            }
        } catch (Exception e) {
            Toast.makeText(this, "Erreur lors du partage.", Toast.LENGTH_LONG).show();
        }
    }

    private boolean isInternalUrl(Uri uri) {
        if (uri == null) return false;

        String host = uri.getHost();
        if (host == null) return false;

        return host.equalsIgnoreCase("batbot.pro")
            || host.toLowerCase().endsWith(".batbot.pro");
    }

    private boolean openExternalUrl(String url) {
        if (url == null || url.trim().isEmpty()) return true;

        try {
            Uri uri = Uri.parse(url);
            String scheme = uri.getScheme();

            if (scheme == null) return true;

            if (scheme.equalsIgnoreCase("http")
                    || scheme.equalsIgnoreCase("https")) {
                Intent intent = new Intent(Intent.ACTION_VIEW, uri);
                startActivity(intent);
                return true;
            }

            if (scheme.equalsIgnoreCase("intent")) {
                try {
                    Intent intent = Intent.parseUri(
                        url, Intent.URI_INTENT_SCHEME
                    );
                    intent.setComponent(null);
                    intent.setSelector(null);
                    startActivity(intent);
                    return true;
                } catch (ActivityNotFoundException e) {
                    Intent parsed = Intent.parseUri(
                        url, Intent.URI_INTENT_SCHEME
                    );
                    String fallback = parsed.getStringExtra(
                        "browser_fallback_url"
                    );
                    if (fallback != null && !fallback.isEmpty()) {
                        return openExternalUrl(fallback);
                    }
                    Toast.makeText(this,
                        "Application non installée.",
                        Toast.LENGTH_SHORT).show();
                    return true;
                }
            }

            if (scheme.equalsIgnoreCase("whatsapp")
                    || scheme.equalsIgnoreCase("tg")
                    || scheme.equalsIgnoreCase("mailto")
                    || scheme.equalsIgnoreCase("tel")
                    || scheme.equalsIgnoreCase("sms")) {
                Intent intent = new Intent(Intent.ACTION_VIEW, uri);
                startActivity(intent);
                return true;
            }

            Toast.makeText(this,
                "Type de lien non pris en charge.",
                Toast.LENGTH_SHORT).show();
            return true;

        } catch (ActivityNotFoundException e) {
            // Repli HTTPS pour certains liens de réseaux sociaux.
            try {
                Uri uri = Uri.parse(url);
                String scheme = uri.getScheme();

                if ("tg".equalsIgnoreCase(scheme)) {
                    String domain = uri.getQueryParameter("domain");
                    if (domain != null && !domain.isEmpty()) {
                        startActivity(new Intent(
                            Intent.ACTION_VIEW,
                            Uri.parse("https://t.me/" + domain)
                        ));
                        return true;
                    }
                }

                if ("whatsapp".equalsIgnoreCase(scheme)) {
                    String phone = uri.getQueryParameter("phone");
                    if (phone != null && !phone.isEmpty()) {
                        startActivity(new Intent(
                            Intent.ACTION_VIEW,
                            Uri.parse("https://wa.me/" + phone)
                        ));
                        return true;
                    }
                }
            } catch (Exception ignored) {
            }

            Toast.makeText(this,
                "Impossible d'ouvrir ce lien. Vérifie l'application installée.",
                Toast.LENGTH_LONG).show();
            return true;

        } catch (Exception e) {
            Toast.makeText(this,
                "Erreur lors de l'ouverture du lien.",
                Toast.LENGTH_SHORT).show();
            return true;
        }
    }

    private boolean handleNavigation(String url) {
        if (url == null) return true;

        Uri uri = Uri.parse(url);

        if (isInternalUrl(uri)) {
            return false;
        }

        return openExternalUrl(url);
    }

    private WebViewClient createWebViewClient() {
        return new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(
                    WebView view, String url) {
                return handleNavigation(url);
            }

            @Override
            public boolean shouldOverrideUrlLoading(
                    WebView view, WebResourceRequest request) {
                return handleNavigation(
                    request.getUrl().toString()
                );
            }
        };
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        requestWindowFeature(Window.FEATURE_NO_TITLE);
        getWindow().setFlags(
            WindowManager.LayoutParams.FLAG_FULLSCREEN,
            WindowManager.LayoutParams.FLAG_FULLSCREEN
        );

        webView = new WebView(this);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        webView.addJavascriptInterface(new AndroidBridge(), "BatBotAndroid");
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(true);
        settings.setSupportMultipleWindows(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);

        webView.setWebViewClient(createWebViewClient());

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(
                    WebView view,
                    ValueCallback<Uri[]> filePathCallback,
                    FileChooserParams fileChooserParams) {

                if (MainActivity.this.filePathCallback != null) {
                    MainActivity.this.filePathCallback.onReceiveValue(null);
                }

                MainActivity.this.filePathCallback = filePathCallback;

                try {
                    Intent intent = fileChooserParams.createIntent();
                    startActivityForResult(intent, FILE_CHOOSER_REQUEST_CODE);
                    return true;
                } catch (Exception e) {
                    if (MainActivity.this.filePathCallback != null) {
                        MainActivity.this.filePathCallback.onReceiveValue(null);
                        MainActivity.this.filePathCallback = null;
                    }
                    Toast.makeText(
                        MainActivity.this,
                        "Impossible d'ouvrir la galerie. Réessayez.",
                        Toast.LENGTH_LONG
                    ).show();
                    return false;
                }
            }

            @Override
            public boolean onCreateWindow(
                    WebView view,
                    boolean isDialog,
                    boolean isUserGesture,
                    Message resultMsg) {

                WebView popupWebView = new WebView(MainActivity.this);

                popupWebView.getSettings().setJavaScriptEnabled(true);
                popupWebView.setWebViewClient(new WebViewClient() {
                    @Override
                    public boolean shouldOverrideUrlLoading(
                            WebView view, String url) {
                        boolean handled = handleNavigation(url);
                        if (handled) view.destroy();
                        return handled;
                    }

                    @Override
                    public boolean shouldOverrideUrlLoading(
                            WebView view, WebResourceRequest request) {
                        boolean handled = handleNavigation(
                            request.getUrl().toString()
                        );
                        if (handled) view.destroy();
                        return handled;
                    }
                });

                WebView.WebViewTransport transport =
                    (WebView.WebViewTransport) resultMsg.obj;
                transport.setWebView(popupWebView);
                resultMsg.sendToTarget();
                return true;
            }
        });

        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);

        setContentView(webView);

        if (savedInstanceState == null) {
            webView.loadUrl("https://www.batbot.pro/");
        } else {
            webView.restoreState(savedInstanceState);
        }
    }

    @Override
    protected void onActivityResult(
            int requestCode,
            int resultCode,
            Intent data) {
        super.onActivityResult(requestCode, resultCode, data);

        if (requestCode == FILE_CHOOSER_REQUEST_CODE) {
            selectedCaptureUri = null;
            if (filePathCallback != null) {
                Uri[] results = null;

                if (resultCode == RESULT_OK && data != null) {
                    Uri selectedUri = data.getData();
                    selectedCaptureUri = selectedUri;
                    if (selectedUri != null) {
                        results = new Uri[]{selectedUri};
                    }
                }

                filePathCallback.onReceiveValue(results);
                filePathCallback = null;
            }
        }
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        if (webView != null) {
            webView.saveState(outState);
        }
        super.onSaveInstanceState(outState);
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
