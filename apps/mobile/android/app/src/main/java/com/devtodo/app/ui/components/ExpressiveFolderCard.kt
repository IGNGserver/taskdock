package com.devtodo.app.ui.components

import androidx.compose.foundation.clickable
import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.devtodo.app.data.local.FolderEntity
import com.devtodo.app.ui.theme.TaskDockShapes
import com.devtodo.app.ui.theme.TaskDockSpacing

@Composable
fun ExpressiveFolderCard(
    folder: FolderEntity,
    itemCount: Int,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    actions: List<RowAction> = emptyList(),
    badgeColor: Color = MaterialTheme.colorScheme.surfaceContainerHighest,
    badgeContentColor: Color = MaterialTheme.colorScheme.onSurfaceVariant,
    rowShape: Shape = TaskDockShapes.TaskRowShape,
) {
    Surface(
        modifier.fillMaxWidth().padding(horizontal = TaskDockSpacing.Page, vertical = 2.dp),
        shape = rowShape, color = MaterialTheme.colorScheme.surfaceContainerLow,
    ) {
        Row(Modifier.fillMaxWidth().padding(start = 8.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Row(
                Modifier.weight(1f).clip(rowShape).clickable(onClickLabel = "打开目录", onClick = onClick)
                    .heightIn(min = 60.dp)
                    .animateContentSize()
                    .padding(start = 4.dp, end = 4.dp, top = 8.dp, bottom = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Surface(shape = TaskDockShapes.Medium, color = badgeColor, modifier = Modifier.size(40.dp)) {
                    Box(contentAlignment = Alignment.Center) {
                        Icon(Icons.Default.Folder, null, Modifier.size(22.dp), tint = badgeContentColor)
                    }
                }
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(folder.title, style = MaterialTheme.typography.bodyLarge, maxLines = 3, overflow = TextOverflow.Ellipsis)
                    Text(if (itemCount > 0) "$itemCount 条任务" else "暂无任务",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Icon(Icons.Default.ChevronRight, null, Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (actions.isNotEmpty()) ActionMenu("${folder.title}，更多操作", actions)
        }
    }
}
