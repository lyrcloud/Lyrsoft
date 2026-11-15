package com.lyrsoft.lyrchat;

import androidx.annotation.NonNull;
import com.capacitorjs.plugins.pushnotifications.MessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.util.Map;

/**
 * Receives Lyr Chat's pushes (data only, see fcmMessage in api/work/lyrchat-model.mjs). While the app
 * is on screen it rings and refreshes itself; otherwise this shows the call or message notification.
 * Replaces the push plugin's own service in AndroidManifest.xml and still passes every push on to it.
 */
public class LyrMessagingService extends MessagingService {
    @Override
    public void onMessageReceived(@NonNull RemoteMessage remoteMessage) {
        Map<String, String> d = remoteMessage.getData();
        String type = d.get("type");
        if (!MainActivity.visible && type != null) {
            switch (type) {
                case "call":
                    LyrNotifications.call(this, d);
                    break;
                case "call-end":
                    LyrNotifications.cancel(this, d.get("tag"));
                    if ("true".equals(d.get("missed")) && d.get("title") != null) LyrNotifications.message(this, d);
                    break;
                case "message":
                    LyrNotifications.message(this, d);
                    break;
                default:
                    break;
            }
        } else if ("call-end".equals(type)) {
            LyrNotifications.cancel(this, d.get("tag"));
        }
        super.onMessageReceived(remoteMessage);
    }
}
