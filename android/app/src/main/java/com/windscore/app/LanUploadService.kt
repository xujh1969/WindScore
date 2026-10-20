package com.windscore.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.IBinder

/** 用户主动开启的局域网上传会话；切换 App 发地址时保持连接与凭证。 */
class LanUploadService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == STOP || controller?.running != true) {
            controller?.stop()
            stopSelf()
            return START_NOT_STICKY
        }
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(CHANNEL, "曲库上传服务", NotificationManager.IMPORTANCE_LOW))
        val open = PendingIntent.getActivity(this, 0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP), PendingIntent.FLAG_IMMUTABLE)
        val stop = PendingIntent.getService(this, 1, Intent(this, LanUploadService::class.java).setAction(STOP), PendingIntent.FLAG_IMMUTABLE)
        val notification = Notification.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_sys_upload)
            .setContentTitle("WindScore 曲库服务运行中")
            .setContentText("可切换应用发送地址；上传后请回到 WindScore 完成入库")
            .setContentIntent(open).setOngoing(true)
            .addAction(Notification.Action.Builder(null, "停用服务", stop).build()).build()
        try { startForeground(1002, notification) }
        catch (_: Exception) { controller?.stop("无法保持上传服务，请回到 WindScore 重新启动"); stopSelf() }
        return START_NOT_STICKY
    }

    override fun onTaskRemoved(rootIntent: Intent?) { controller?.stop("应用已退出，上传服务已停用"); stopSelf() }
    override fun onDestroy() {
        controller?.let { if (it.running) it.stop("上传服务已停用") }
        controller = null
        super.onDestroy()
    }

    companion object {
        @Volatile var controller: LanUploadController? = null
        private const val CHANNEL = "windscore-upload"
        private const val STOP = "com.windscore.app.STOP_UPLOAD"
    }
}
