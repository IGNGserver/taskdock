package com.devtodo.app.data.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import java.util.UUID

@Serializable
enum class TaskStatus {
    TODO, IN_PROGRESS, DONE
}

@Serializable
enum class TaskCategory {
    FEATURE, MISC
}

@Serializable
enum class TaskPriority {
    NONE, LOW, MEDIUM, HIGH
}

@Serializable
enum class TimePointType {
    DATE, EVENT
}

@Serializable
data class UserDto(
    val id: String,
    val username: String,
    val role: String? = "owner",
    val createdAt: String? = null,
    val updatedAt: String? = null
)

@Serializable
data class SettingsDto(
    val ownerId: String,
    val timezone: String,
    val defaultCaptureTarget: String = "GLOBAL_MISC",
    val recentProjectId: String? = null,
    val createdAt: String? = null,
    val updatedAt: String? = null
)

@Serializable
data class ProjectDto(
    val id: String,
    val ownerId: String? = null,
    val name: String,
    val slug: String? = null,
    val taskPrefix: String? = null,
    val description: String = "",
    val rank: String,
    val version: Long = 1,
    val archivedAt: String? = null,
    val createdAt: String? = null,
    val updatedAt: String? = null
)

@Serializable
data class TaskDto(
    val id: String,
    val ownerId: String? = null,
    val projectId: String? = null,
    val referenceId: String? = null,
    val title: String,
    val status: TaskStatus = TaskStatus.TODO,
    val category: TaskCategory = TaskCategory.MISC,
    val priority: TaskPriority = TaskPriority.NONE,
    val rank: String,
    val version: Long = 1,
    val archivedAt: String? = null,
    val createdAt: String? = null,
    val updatedAt: String? = null
)

@Serializable
data class NoteDto(
    val id: String,
    val ownerId: String? = null,
    val taskId: String,
    val contentMarkdown: String = "",
    val version: Long = 1,
    val createdAt: String? = null,
    val updatedAt: String? = null
)

@Serializable
data class TimePointDto(
    val id: String,
    val ownerId: String? = null,
    val type: TimePointType,
    val localDate: String? = null,
    val title: String? = null,
    val rank: String,
    val version: Long = 1,
    val reachedAt: String? = null,
    val archivedAt: String? = null,
    val createdAt: String? = null,
    val updatedAt: String? = null
)

@Serializable
data class PlacementDto(
    val id: String,
    val ownerId: String? = null,
    val taskId: String,
    val timePointId: String,
    val rank: String,
    val version: Long = 1,
    val createdAt: String? = null,
    val updatedAt: String? = null
)

@Serializable
data class Mutation(
    val mutationId: String = UUID.randomUUID().toString(),
    val command: String,
    val entityId: String,
    val baseVersion: Long? = null,
    val occurredAt: String,
    val payload: Map<String, kotlinx.serialization.json.JsonElement>
)

@Serializable
data class PushRequest(
    val protocolVersion: Int = 1,
    val clientId: String,
    val mutations: List<Mutation>
)

@Serializable
data class PushMutationResult(
    val mutationId: String,
    val status: String,
    val code: String? = null,
    val message: String? = null,
    val result: kotlinx.serialization.json.JsonElement? = null
)

@Serializable
data class PushResult(
    val results: List<PushMutationResult>
)

@Serializable
data class PullResult(
    @SerialName("nextCursor") val cursor: String,
    val changes: List<ChangeItem>,
    val hasMore: Boolean
)

@Serializable
data class ChangeItem(
    val seq: String,
    val entityType: String,
    val entityId: String,
    val entityVersion: Long,
    val operation: String,
    val snapshot: kotlinx.serialization.json.JsonElement? = null
)

@Serializable
data class SnapshotResult(
    val cursor: String,
    val projects: List<ProjectDto>,
    val tasks: List<TaskDto>,
    val notes: List<NoteDto>,
    val timePoints: List<TimePointDto>,
    val placements: List<PlacementDto>,
    val settings: SettingsDto? = null
)

@Serializable
data class HubStatusResponse(
    val initialized: Boolean,
    val version: String? = null,
    val name: String? = "TaskDock Hub"
)

@Serializable
data class LoginResponse(
    val accessToken: String,
    val refreshToken: String? = null,
    val user: UserDto
)
