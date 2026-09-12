package com.devtodo.app.data.local

import androidx.room.Entity
import androidx.room.PrimaryKey
import com.devtodo.app.data.model.TaskCategory
import com.devtodo.app.data.model.TaskPriority
import com.devtodo.app.data.model.TaskStatus
import com.devtodo.app.data.model.TimePointType

@Entity(tableName = "projects")
data class ProjectEntity(
    @PrimaryKey val id: String,
    val ownerId: String,
    val name: String,
    val slug: String,
    val description: String,
    val rank: String,
    val version: Long,
    val archivedAt: String?,
    val createdAt: String,
    val updatedAt: String,
    val pendingSync: Boolean = false
)

@Entity(tableName = "tasks")
data class TaskEntity(
    @PrimaryKey val id: String,
    val ownerId: String,
    val projectId: String?,
    val referenceId: String?,
    val title: String,
    val status: TaskStatus,
    val category: TaskCategory,
    val priority: TaskPriority,
    val rank: String,
    val version: Long,
    val archivedAt: String?,
    val createdAt: String,
    val updatedAt: String,
    val pendingSync: Boolean = false
)

@Entity(tableName = "notes")
data class NoteEntity(
    @PrimaryKey val id: String,
    val ownerId: String,
    val taskId: String,
    val contentMarkdown: String,
    val version: Long,
    val createdAt: String,
    val updatedAt: String,
    val pendingSync: Boolean = false
)

@Entity(tableName = "time_points")
data class TimePointEntity(
    @PrimaryKey val id: String,
    val ownerId: String,
    val type: TimePointType,
    val localDate: String?,
    val title: String?,
    val rank: String,
    val version: Long,
    val reachedAt: String?,
    val archivedAt: String?,
    val createdAt: String,
    val updatedAt: String,
    val pendingSync: Boolean = false
)

@Entity(tableName = "placements")
data class PlacementEntity(
    @PrimaryKey val id: String,
    val ownerId: String,
    val taskId: String,
    val timePointId: String,
    val rank: String,
    val version: Long,
    val createdAt: String,
    val updatedAt: String,
    val pendingSync: Boolean = false
)

@Entity(tableName = "settings")
data class SettingsEntity(
    @PrimaryKey val ownerId: String,
    val timezone: String,
    val defaultCaptureTarget: String,
    val recentProjectId: String?,
    val createdAt: String,
    val updatedAt: String
)

@Entity(tableName = "outbox")
data class OutboxEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val mutationId: String,
    val clientId: String,
    val ownerId: String,
    val command: String,
    val entityId: String,
    val baseVersion: Long?,
    val occurredAt: String,
    val payloadJson: String,
    val attempts: Int = 0,
    val nextAttemptAt: Long = 0,
    val lastError: String? = null
)

@Entity(tableName = "conflicts")
data class ConflictEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val mutationId: String,
    val ownerId: String,
    val command: String?,
    val entityType: String,
    val entityId: String,
    val localJson: String,
    val serverJson: String,
    val createdAt: String,
    val resolvedAt: String? = null
)

@Entity(tableName = "sync_meta")
data class SyncMetaEntity(
    @PrimaryKey val key: String,
    val value: String
)
