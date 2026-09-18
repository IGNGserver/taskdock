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
enum class FolderStatus {
    TODO, IN_PROGRESS, DONE
}

@Serializable
data class FolderAggregateDto(
    val status: FolderStatus,
    val todoCount: Int,
    val inProgressCount: Int,
    val doneCount: Int,
    val totalCount: Int
)

@Serializable
data class FolderDto(
    val id: String,
    val ownerId: String? = null,
    val parentFolderId: String? = null,
    val title: String,
    val rank: String,
    val version: Long = 1,
    val archivedAt: String? = null,
    val archivedByOperationId: String? = null,
    val deletedAt: String? = null,
    val createdAt: String? = null,
    val updatedAt: String? = null
)

@Serializable
data class TreeTaskDto(
    val id: String,
    val ownerId: String? = null,
    val referenceId: String,
    val parentFolderId: String? = null,
    val title: String,
    val status: TaskStatus = TaskStatus.TODO,
    val rank: String,
    val version: Long = 1,
    val completedAt: String? = null,
    val archivedAt: String? = null,
    val archivedByOperationId: String? = null,
    val createdAt: String? = null,
    val updatedAt: String? = null,
    val deletedAt: String? = null
)

@Serializable
data class TreeItemDto(
    val kind: String,
    val folder: FolderDto? = null,
    val aggregate: FolderAggregateDto? = null,
    val task: TreeTaskDto? = null
)

@Serializable
data class TaskStepDto(
    val id: String,
    val ownerId: String? = null,
    val taskId: String,
    val title: String,
    val noteMarkdown: String = "",
    val status: TaskStatus = TaskStatus.TODO,
    val rank: String,
    val completedAt: String? = null,
    val version: Long = 1,
    val createdAt: String? = null,
    val updatedAt: String? = null,
    val deletedAt: String? = null
)

@Serializable
data class WorkflowTaskMembershipDto(
    val id: String,
    val ownerId: String? = null,
    val workflowId: String,
    val stageId: String,
    val taskId: String,
    val rank: String,
    val version: Long = 1,
    val createdAt: String? = null,
    val updatedAt: String? = null,
    val deletedAt: String? = null
)

@Serializable
data class WorkflowStageDto(
    val id: String,
    val ownerId: String? = null,
    val workflowId: String,
    val name: String,
    val rank: String,
    val version: Long = 1,
    val createdAt: String? = null,
    val updatedAt: String? = null,
    val deletedAt: String? = null,
    val tasks: List<TreeTaskDto> = emptyList()
)

@Serializable
data class WorkflowDto(
    val id: String,
    val ownerId: String? = null,
    val name: String,
    val rank: String,
    val version: Long = 1,
    val archivedAt: String? = null,
    val createdAt: String? = null,
    val updatedAt: String? = null,
    val deletedAt: String? = null,
    val stages: List<WorkflowStageDto> = emptyList()
)

@Serializable
data class ArchiveOperationDto(
    val id: String,
    val ownerId: String? = null,
    val rootFolderId: String,
    val rootBaseVersion: Long,
    val folderCount: Int,
    val taskCount: Int,
    val createdAt: String? = null,
    val restoredAt: String? = null
)

@Serializable
data class TaskDetailV2Dto(
    val task: TreeTaskDto,
    val note: NoteDto,
    val steps: List<TaskStepDto> = emptyList(),
    val placements: List<PlacementDto> = emptyList(),
    val workflowMemberships: List<WorkflowTaskMembershipDto> = emptyList(),
    val folderPath: List<FolderDto> = emptyList()
)

@Serializable
data class V2SettingsDto(
    val ownerId: String,
    val timezone: String,
    val weekStartsOn: Int = 1,
    val defaultCaptureTarget: String = "ROOT",
    val version: Long = 1,
    val updatedAt: String? = null
)

@Serializable
data class DeletePreviewDto(
    val rootFolderId: String,
    val title: String,
    val folderCount: Int,
    val taskCount: Int,
    val noteCount: Int,
    val stepCount: Int,
    val placementCount: Int,
    val workflowMembershipCount: Int,
    val subtreeFingerprint: String,
    val expiresAt: String,
    val confirmationToken: String
)

@Serializable
data class NoteDto(
    val id: String,
    val ownerId: String? = null,
    val taskId: String,
    val contentMarkdown: String = "",
    val version: Long = 1,
    val createdAt: String? = null,
    val updatedAt: String? = null,
    val deletedAt: String? = null
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
    val deletedAt: String? = null,
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
    val updatedAt: String? = null,
    val deletedAt: String? = null
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
data class V2PushRequest(
    val protocolVersion: Int = 2,
    val clientId: String,
    val mutations: List<Mutation>
)

@Serializable
data class PushMutationResult(
    val mutationId: String,
    val status: String,
    val code: String? = null,
    val message: String? = null,
    val error: kotlinx.serialization.json.JsonElement? = null,
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
data class V2SnapshotResult(
    val folders: List<FolderDto> = emptyList(),
    val tasks: List<TreeTaskDto> = emptyList(),
    val notes: List<NoteDto> = emptyList(),
    val taskSteps: List<TaskStepDto> = emptyList(),
    val timePoints: List<TimePointDto> = emptyList(),
    val placements: List<PlacementDto> = emptyList(),
    val workflows: List<WorkflowDto> = emptyList(),
    val workflowStages: List<WorkflowStageDto> = emptyList(),
    val workflowTaskMemberships: List<WorkflowTaskMembershipDto> = emptyList(),
    val archiveOperations: List<ArchiveOperationDto> = emptyList(),
    val settings: V2SettingsDto? = null,
    val cursor: String = "0"
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
