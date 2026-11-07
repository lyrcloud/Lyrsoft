package com.lyrsoft.lyrchat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Tells lyrsoft.com/chat/ about this build. Push notifications need Firebase, which is only set up
 * when the app was built with android/app/google-services.json (the google-services Gradle plugin then
 * adds the google_app_id string). Without it, registering for push would crash the app, so Lyr Chat
 * checks first and rings only while it's open.
 */
@CapacitorPlugin(name = "LyrApp")
public class LyrAppPlugin extends Plugin {
    @PluginMethod
    public void info(PluginCall call) {
        int id = getContext().getResources().getIdentifier("google_app_id", "string", getContext().getPackageName());
        JSObject result = new JSObject();
        result.put("firebase", id != 0);
        result.put("version", BuildConfig.VERSION_NAME);
        call.resolve(result);
    }
}
