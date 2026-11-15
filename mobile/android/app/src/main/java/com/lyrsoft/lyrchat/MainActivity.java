package com.lyrsoft.lyrchat;

import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    static final String EXTRA_URL = "lyrUrl";
    static final String EXTRA_CANCEL_TAG = "lyrCancelTag";
    /** Lyr Chat is on screen, so it rings and shows new messages itself. */
    static volatile boolean visible = false;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(LyrAppPlugin.class);
        super.onCreate(savedInstanceState);
        LyrNotifications.createChannels(this);
        openFromNotification(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        openFromNotification(intent);
    }

    @Override
    public void onResume() {
        super.onResume();
        visible = true;
        LyrNotifications.cancelCalls(this);
    }

    @Override
    public void onPause() {
        visible = false;
        super.onPause();
    }

    // A notification was tapped: open that chat or call (and show over the lock screen for a call).
    private void openFromNotification(Intent intent) {
        if (intent == null) return;
        String url = intent.getStringExtra(EXTRA_URL);
        if (url == null || !url.startsWith("/")) return;
        String tag = intent.getStringExtra(EXTRA_CANCEL_TAG);
        LyrNotifications.cancel(this, tag);
        if (tag != null && tag.startsWith("call-") && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        }
        intent.removeExtra(EXTRA_URL);
        if (getBridge() != null && getBridge().getWebView() != null) {
            getBridge().getWebView().post(() -> getBridge().getWebView().loadUrl(LyrNotifications.SITE + url));
        }
    }
}
