package com.lyrsoft.lyrchat;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.media.AudioAttributes;
import android.net.Uri;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import java.util.Map;

/**
 * Lyr Chat's notifications while the app is closed or in the background. Android fixes a channel's
 * sound when the channel is made, so there's one channel per ringtone (call_<id>) and per message tone
 * (msg_<id>); the sounds are res/raw/ring_<id>.wav and tone_<id>.wav, picked in Lyr Chat's Settings
 * (LyrAppPlugin.setSounds). Calls ring full screen until answered, declined or ended.
 */
public final class LyrNotifications {
    static final String[] RINGTONES = { "marimba", "classic", "bells", "harp", "pulse", "sunrise" };
    static final String[] TONES = { "pop", "ding", "bubble", "glass", "chord", "marimba", "none" };
    static final String SITE = "https://lyrsoft.com";
    static final int ID = 1;
    private static final long RING_MS = 50_000;

    private LyrNotifications() {}

    static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences("lyrchat", Context.MODE_PRIVATE);
    }

    static String pick(String value, String[] allowed) {
        for (String a : allowed) if (a.equals(value)) return a;
        return allowed[0];
    }

    static void createChannels(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        AudioAttributes ring = new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build();
        AudioAttributes tone = new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION_COMMUNICATION_INSTANT)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build();
        for (String id : RINGTONES) {
            NotificationChannel c = new NotificationChannel("call_" + id, "Calls · " + title(id), NotificationManager.IMPORTANCE_HIGH);
            c.setDescription("Incoming voice and video calls");
            c.setSound(sound(ctx, "ring_" + id), ring);
            c.enableVibration(true);
            c.setVibrationPattern(new long[] { 0, 800, 600, 800, 600 });
            c.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            c.setGroup(null);
            nm.createNotificationChannel(c);
        }
        for (String id : TONES) {
            NotificationChannel c = new NotificationChannel("msg_" + id, "Messages · " + title(id), NotificationManager.IMPORTANCE_HIGH);
            c.setDescription("New messages and missed calls");
            if ("none".equals(id)) {
                c.setSound(null, null);
                c.enableVibration(false);
            } else {
                c.setSound(sound(ctx, "tone_" + id), tone);
                c.enableVibration(true);
            }
            nm.createNotificationChannel(c);
        }
    }

    private static String title(String id) {
        return "none".equals(id) ? "Silent" : Character.toUpperCase(id.charAt(0)) + id.substring(1);
    }

    private static Uri sound(Context ctx, String raw) {
        return Uri.parse("android.resource://" + ctx.getPackageName() + "/raw/" + raw);
    }

    /** Opens Lyr Chat at a lyrsoft.com path such as /chat/#/chat/<id>. */
    static PendingIntent open(Context ctx, String url, String cancelTag, int request) {
        Intent intent = new Intent(ctx, MainActivity.class)
            .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra(MainActivity.EXTRA_URL, url == null || url.isEmpty() ? "/chat/" : url)
            .putExtra(MainActivity.EXTRA_CANCEL_TAG, cancelTag)
            .setAction("lyrchat.open." + request);
        return PendingIntent.getActivity(ctx, request, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    static void call(Context ctx, Map<String, String> d) {
        String tag = or(d.get("tag"), "call-" + d.get("callId"));
        String url = or(d.get("url"), "/chat/");
        String ringId = pick(prefs(ctx).getString("ring", null), RINGTONES);
        int req = tag.hashCode();
        Intent decline = new Intent(ctx, CallActionReceiver.class)
            .setAction("lyrchat.decline." + req)
            .putExtra("callId", d.get("callId"))
            .putExtra("email", d.get("email"))
            .putExtra("token", d.get("token"))
            .putExtra("tag", tag);
        PendingIntent declinePi = PendingIntent.getBroadcast(ctx, req, decline, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        PendingIntent full = open(ctx, url, tag, req + 1);
        PendingIntent answer = open(ctx, url + (url.contains("?") ? "&" : "?") + "answer=1", tag, req + 2);
        boolean video = "true".equals(d.get("video"));
        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, "call_" + ringId)
            .setSmallIcon(R.drawable.ic_stat_lyrchat)
            .setContentTitle(or(d.get("title"), video ? "Incoming video call" : "Incoming voice call"))
            .setContentText(or(d.get("body"), "Lyr Chat"))
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setAutoCancel(true)
            .setTimeoutAfter(RING_MS)
            .setSound(sound(ctx, "ring_" + ringId))
            .setVibrate(new long[] { 0, 800, 600, 800, 600 })
            .setContentIntent(full)
            .setFullScreenIntent(full, true)
            .addAction(0, "Decline", declinePi)
            .addAction(0, "Answer", answer);
        Notification n = b.build();
        n.flags |= Notification.FLAG_INSISTENT; // ring until it's dealt with
        notify(ctx, tag, n);
    }

    static void message(Context ctx, Map<String, String> d) {
        String tag = or(d.get("tag"), "lyrchat");
        String toneId = pick(prefs(ctx).getString("tone", null), TONES);
        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, "msg_" + toneId)
            .setSmallIcon(R.drawable.ic_stat_lyrchat)
            .setContentTitle(or(d.get("title"), "Lyr Chat"))
            .setContentText(d.get("body"))
            .setStyle(new NotificationCompat.BigTextStyle().bigText(d.get("body")))
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(open(ctx, d.get("url"), null, tag.hashCode() + 3));
        if ("none".equals(toneId)) b.setSilent(true);
        else b.setSound(sound(ctx, "tone_" + toneId));
        notify(ctx, tag, b.build());
    }

    static void cancel(Context ctx, String tag) {
        if (tag != null) NotificationManagerCompat.from(ctx).cancel(tag, ID);
    }

    /** The app came to the front: it rings for itself now. */
    static void cancelCalls(Context ctx) {
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return;
        for (android.service.notification.StatusBarNotification s : nm.getActiveNotifications()) {
            if (s.getTag() != null && s.getTag().startsWith("call-") && (s.getNotification().flags & Notification.FLAG_INSISTENT) != 0) nm.cancel(s.getTag(), s.getId());
        }
    }

    private static void notify(Context ctx, String tag, Notification n) {
        try {
            NotificationManagerCompat.from(ctx).notify(tag, ID, n);
        } catch (SecurityException e) {
            // Notifications aren't allowed on this phone.
        }
    }

    private static String or(String value, String fallback) {
        return value == null || value.isEmpty() ? fallback : value;
    }
}
