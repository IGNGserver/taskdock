package com.devtodo.app;

import android.content.res.Configuration;
import android.os.Bundle;
import android.webkit.WebView;

import androidx.core.content.ContextCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;

import org.json.JSONObject;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        applySystemTheme(getResources().getConfiguration());
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        applySystemTheme(newConfig);
    }

    @Override
    public void onResume() {
        super.onResume();
        applySystemTheme(getResources().getConfiguration());
    }

    private void applySystemTheme(Configuration configuration) {
        int nightMode = configuration.uiMode & Configuration.UI_MODE_NIGHT_MASK;
        boolean dark = nightMode == Configuration.UI_MODE_NIGHT_YES;
        WindowInsetsControllerCompat controller =
                WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        controller.setAppearanceLightStatusBars(!dark);
        controller.setAppearanceLightNavigationBars(!dark);
        int systemBarColor = ContextCompat.getColor(this, R.color.taskdock_system_bar);
        getWindow().setStatusBarColor(systemBarColor);
        getWindow().setNavigationBarColor(systemBarColor);
        dispatchThemeToWebView(dark ? "dark" : "light");
    }

    private void dispatchThemeToWebView(String theme) {
        if (getBridge() == null || getBridge().getWebView() == null) return;
        WebView webView = getBridge().getWebView();
        String encodedTheme = JSONObject.quote(theme);
        String script =
                "(() => { window.__DEVTODO_NATIVE_THEME__ = " + encodedTheme + "; "
                        + "window.dispatchEvent(new CustomEvent('devtodo:native-theme-changed', "
                        + "{ detail: { theme: " + encodedTheme + " } })); })();";
        webView.post(() -> webView.evaluateJavascript(script, null));
    }
}
