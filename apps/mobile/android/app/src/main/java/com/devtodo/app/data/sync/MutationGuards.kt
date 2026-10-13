package com.devtodo.app.data.sync

import com.devtodo.app.data.local.*
import kotlinx.serialization.json.*

/** Reference-counted protection, including the entities affected by cascades. */
class MutationGuards(private val db: AppDatabase, private val json: Json) {
    companion object {
        val tables = mapOf("folder" to "folders", "task" to "tasks", "note" to "notes",
            "taskStep" to "task_steps", "timePoint" to "time_points", "placement" to "placements",
            "workflow" to "workflows", "workflowStage" to "workflow_stages",
            "workflowTaskMembership" to "workflow_task_memberships", "project" to "projects")
    }

    suspend fun track(item: OutboxEntity) {
        val payload = json.parseToJsonElement(item.payloadJson).jsonObject
        val targets = mutableSetOf<Pair<String, String>>()
        fun add(type: String, id: String?) { if (id != null) targets += type to id }
        var type = item.command.substringBefore('.')
        if (type == "workflowTask") type = "workflowTaskMembership"
        if (type == "tree") type = if (payload["item"]?.jsonObject?.get("kind")?.jsonPrimitive?.content == "FOLDER") "folder" else "task"
        if (type == "note") add(type, db.noteDao().getNoteByTaskId(item.entityId, item.ownerId)?.id)
        else add(type, item.entityId)
        if (item.command == "task.create") {
            add("note", payload["noteId"]?.jsonPrimitive?.contentOrNull)
            add("note", db.noteDao().getNoteByTaskId(item.entityId, item.ownerId)?.id)
        }
        if (item.command in setOf("folder.archiveTree", "folder.restoreTree", "folder.deleteTree")) {
            val folders = db.folderDao().getAll(item.ownerId)
            val ids = mutableSetOf(item.entityId)
            var changed: Boolean
            do { changed = false; folders.forEach { if (it.parentFolderId in ids && ids.add(it.id)) changed = true } } while (changed)
            ids.forEach { add("folder", it) }
            db.taskDao().getAllTreeTasks(item.ownerId).filter { it.parentFolderId in ids }.forEach { add("task", it.id) }
        }
        if (item.command == "task.duplicate") {
            add("task", payload["taskId"]?.jsonPrimitive?.contentOrNull)
            add("note", payload["noteId"]?.jsonPrimitive?.contentOrNull)
            payload["stepIds"]?.jsonArray?.forEach { add("taskStep", it.jsonPrimitive.contentOrNull) }
        }
        if (item.command == "workflow.create") add("workflowStage", payload["defaultStageId"]?.jsonPrimitive?.contentOrNull)
        for (entityType in listOf("timePoint", "placement")) {
            payload["ids"]?.jsonArray?.takeIf { type == entityType }?.forEach { add(entityType, it.jsonPrimitive.contentOrNull) }
        }
        add("placement", payload["targetPlacementId"]?.jsonPrimitive?.contentOrNull)
        if (item.command.endsWith(".delete") || item.command == "folder.deleteTree") {
            val links = when (type) {
                "task" -> mapOf("note" to "taskId", "taskStep" to "taskId", "placement" to "taskId", "workflowTaskMembership" to "taskId")
                "workflow" -> mapOf("workflowStage" to "workflowId", "workflowTaskMembership" to "workflowId")
                "timePoint" -> mapOf("placement" to "timePointId")
                "folder" -> emptyMap()
                else -> emptyMap()
            }
            if (item.command == "folder.deleteTree") {
                val taskIds = targets.filter { it.first == "task" }.map { it.second }
                for (taskId in taskIds) for ((childType, column) in mapOf("note" to "taskId", "taskStep" to "taskId", "placement" to "taskId", "workflowTaskMembership" to "taskId")) {
                    db.openHelper.readableDatabase.query("SELECT id FROM ${tables.getValue(childType)} WHERE ownerId = ? AND $column = ?", arrayOf(item.ownerId, taskId)).use { cursor ->
                        while (cursor.moveToNext()) add(childType, cursor.getString(0))
                    }
                }
            }
            links.forEach { (childType, column) ->
                db.openHelper.readableDatabase.query("SELECT id FROM ${tables.getValue(childType)} WHERE ownerId = ? AND $column = ?", arrayOf(item.ownerId, item.entityId)).use { cursor ->
                    while (cursor.moveToNext()) add(childType, cursor.getString(0))
                }
            }
        }
        db.syncJournalDao().guard(targets.map { SyncGuardEntity(item.mutationId, it.first, it.second) })
        targets.forEach { (entityType, id) ->
            tables[entityType]?.let { table -> db.openHelper.writableDatabase.execSQL(
                "UPDATE $table SET pendingSync = 1 WHERE ownerId = ? AND id = ?", arrayOf(item.ownerId, id)) }
        }
    }

    suspend fun release(item: OutboxEntity) {
        val affected = db.syncJournalDao().guards().filter { it.mutationId == item.mutationId }
        db.syncJournalDao().release(item.mutationId)
        affected.forEach { guard ->
            if (db.syncJournalDao().guardCount(guard.entityType, guard.entityId) == 0) {
                tables[guard.entityType]?.let { table ->
                    db.openHelper.writableDatabase.execSQL("UPDATE $table SET pendingSync = 0 WHERE ownerId = ? AND id = ?", arrayOf(item.ownerId, guard.entityId))
                }
            }
        }
    }
}
