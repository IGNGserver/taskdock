package com.devtodo.app.ui.screens

import com.devtodo.app.data.local.FolderEntity
import com.devtodo.app.data.local.TaskLocation
import com.devtodo.app.data.model.TaskStatus

/** One background pass over lightweight projections, not a full tree per row. */
fun directoryAggregates(folders: List<FolderEntity>, tasks: List<TaskLocation>): Map<String, Pair<TaskStatus, Int>> {
    val active = folders.filter { it.archivedAt == null && it.deletedAt == null }.associateBy { it.id }
    val counts = active.keys.associateWith { IntArray(3) }.toMutableMap()
    tasks.forEach { task ->
        counts[task.parentFolderId]?.let { value ->
            value[0]++; if (task.status == TaskStatus.TODO) value[1]++; if (task.status == TaskStatus.DONE) value[2]++
        }
    }
    val remainingChildren = active.keys.associateWith { 0 }.toMutableMap()
    active.values.forEach { folder -> folder.parentFolderId?.let { parent ->
        if (parent in active) remainingChildren[parent] = remainingChildren.getValue(parent) + 1
    } }
    val queue = ArrayDeque(active.keys.filter { remainingChildren[it] == 0 })
    val processed = mutableSetOf<String>()
    while (queue.isNotEmpty()) {
        val id = queue.removeFirst()
        processed += id
        active[id]?.parentFolderId?.let { parent ->
            counts[parent]?.let { destination ->
                val source = counts.getValue(id)
                for (i in 0..2) destination[i] += source[i]
                val remaining = remainingChildren.getValue(parent) - 1
                remainingChildren[parent] = remaining
                if (remaining == 0) queue.add(parent)
            }
        }
    }
    // Corrupt cycles are the only nodes left after leaves have been folded.
    // Count each component once, without recursion or unbounded parent walks.
    for (start in active.keys - processed) {
        if (start in processed) continue
        val component = mutableListOf<String>()
        var id: String? = start
        while (id != null && id in active && processed.add(id)) {
            component += id
            id = active[id]?.parentFolderId
        }
        val sum = IntArray(3)
        component.forEach { member -> for (i in 0..2) sum[i] += counts.getValue(member)[i] }
        component.forEach { counts[it] = sum.copyOf() }
    }
    return active.mapValues { (id, _) ->
        val value = counts[id] ?: IntArray(3)
        val status = when { value[0] == 0 || value[0] == value[1] -> TaskStatus.TODO
            value[0] == value[2] -> TaskStatus.DONE; else -> TaskStatus.IN_PROGRESS }
        status to value[0]
    }
}
