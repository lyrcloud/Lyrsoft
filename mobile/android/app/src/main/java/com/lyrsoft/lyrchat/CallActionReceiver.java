package com.lyrsoft.lyrchat;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

/** "Decline" on a call notification: tells lyrsoft.com (POST /public/call, signed token) without opening the app. */
public class CallActionReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        LyrNotifications.cancel(context, intent.getStringExtra("tag"));
        final String callId = intent.getStringExtra("callId");
        final String email = intent.getStringExtra("email");
        final String token = intent.getStringExtra("token");
        if (callId == null || token == null) return;
        final PendingResult pending = goAsync();
        new Thread(() -> {
            HttpURLConnection conn = null;
            try {
                JSONObject body = new JSONObject().put("id", callId).put("email", email).put("t", token).put("action", "decline");
                conn = (HttpURLConnection) new URL(LyrNotifications.SITE + "/public/call").openConnection();
                conn.setRequestMethod("POST");
                conn.setConnectTimeout(8000);
                conn.setReadTimeout(8000);
                conn.setDoOutput(true);
                conn.setRequestProperty("content-type", "application/json");
                try (OutputStream out = conn.getOutputStream()) {
                    out.write(body.toString().getBytes(StandardCharsets.UTF_8));
                }
                conn.getResponseCode();
            } catch (Exception ignored) {
                // Offline: the call stops ringing on its own.
            } finally {
                if (conn != null) conn.disconnect();
                pending.finish();
            }
        }).start();
    }
}
