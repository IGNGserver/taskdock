package com.devtodo.app.data.local

import android.content.Context
import android.database.Cursor
import android.net.Uri
import androidx.room.withTransaction
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.*

/** Export, never auto-submit an unscoped legacy Outbox to the selected Hub. */
object LegacyCacheBackup {
    fun exists(context: Context) = context.getDatabasePath("devtodo_local.db").exists()

    suspend fun export(context: Context, destination: Uri) = withContext(Dispatchers.IO) {
        require(exists(context)) { "没有旧版缓存" }
        val db = AppDatabase.getInstance(context)
        val payload = db.withTransaction {
            buildJsonObject {
                put("format", "taskdock-unscoped-cache-v1")
                put("warning", "中枢归属未经验证；不得直接自动上传。备份包含个人任务内容，请妥善保管。")
                putJsonObject("tables") {
                    for (table in listOf("projects", "tasks", "notes", "folders", "task_steps", "time_points",
                        "placements", "workflows", "workflow_stages", "workflow_task_memberships", "settings",
                        "archive_operations", "outbox", "conflicts", "sync_meta")) {
                        putJsonArray(table) {
                            db.openHelper.readableDatabase.query("SELECT * FROM $table").use { cursor ->
                                while (cursor.moveToNext()) add(buildJsonObject {
                                    for (i in 0 until cursor.columnCount) put(cursor.getColumnName(i), when (cursor.getType(i)) {
                                        Cursor.FIELD_TYPE_NULL -> JsonNull
                                        Cursor.FIELD_TYPE_INTEGER -> JsonPrimitive(cursor.getLong(i))
                                        Cursor.FIELD_TYPE_FLOAT -> JsonPrimitive(cursor.getDouble(i))
                                        else -> JsonPrimitive(cursor.getString(i))
                                    })
                                })
                            }
                        }
                    }
                }
            }
        }
        val output = context.contentResolver.openOutputStream(destination, "wt") ?: error("无法打开备份文件")
        output.bufferedWriter().use { it.write(payload.toString()) }
    }
}
