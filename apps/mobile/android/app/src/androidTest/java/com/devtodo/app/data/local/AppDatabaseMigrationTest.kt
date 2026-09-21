package com.devtodo.app.data.local

import androidx.room.testing.MigrationTestHelper
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class AppDatabaseMigrationTest {
    @get:Rule
    val helper = MigrationTestHelper(
        InstrumentationRegistry.getInstrumentation(),
        AppDatabase::class.java,
    )

    @Test
    fun migrateV3ToV5PreservesLegacyRowsAndCreatesV2Tables() {
        val databaseName = "taskdock-v3-fixture"
        helper.createDatabase(databaseName, 3).apply {
            execSQL("INSERT INTO projects (id,ownerId,name,slug,description,rank,version,archivedAt,createdAt,updatedAt,pendingSync) VALUES ('p1','u1','Legacy project','LEG','', '1024',2,NULL,'2026-09-13T00:00:00Z','2026-09-13T00:00:00Z',0)")
            execSQL("INSERT INTO tasks (id,ownerId,projectId,referenceId,title,status,category,priority,rank,version,archivedAt,createdAt,updatedAt,pendingSync) VALUES ('t1','u1','p1','LEG-1','Legacy task','TODO','FEATURE','HIGH','1024',3,NULL,'2026-09-13T00:00:00Z','2026-09-13T00:00:00Z',1)")
            execSQL("INSERT INTO notes (id,ownerId,taskId,contentMarkdown,version,createdAt,updatedAt,pendingSync) VALUES ('n1','u1','t1','[LEG-1] preserved',2,'2026-09-13T00:00:00Z','2026-09-13T00:00:00Z',1)")
            execSQL("INSERT INTO outbox (mutationId,clientId,ownerId,command,entityId,baseVersion,occurredAt,payloadJson,attempts,nextAttemptAt,lastError) VALUES ('m1','c1','u1','task.update','t1',3,'2026-09-13T00:00:00Z','{}',0,0,NULL)")
            execSQL("INSERT INTO conflicts (mutationId,ownerId,command,entityType,entityId,localJson,serverJson,createdAt,resolvedAt) VALUES ('m1','u1','task.update','task','t1','{}','{}','2026-09-13T00:00:00Z',NULL)")
            execSQL("INSERT INTO sync_meta (`key`,value) VALUES ('legacy-cursor','17')")
            execSQL("INSERT INTO settings (ownerId,timezone,defaultCaptureTarget,recentProjectId,createdAt,updatedAt) VALUES ('u1','Asia/Shanghai','GLOBAL_MISC',NULL,'2026-09-13T00:00:00Z','2026-09-13T00:00:00Z')")
            close()
        }

        val migrated = helper.runMigrationsAndValidate(
            databaseName,
            6,
            true,
            AppDatabase.MIGRATION_3_4,
            AppDatabase.MIGRATION_4_5,
            AppDatabase.MIGRATION_5_6,
        )
        migrated.query("SELECT title, parentFolderId FROM folders WHERE id='p1'").use { cursor ->
            assertEquals(true, cursor.moveToFirst())
            assertEquals("Legacy project", cursor.getString(0))
            assertEquals(null, cursor.getString(1))
        }
        migrated.query("SELECT parentFolderId, priority FROM tasks WHERE id='t1'").use { cursor ->
            assertEquals(true, cursor.moveToFirst())
            assertEquals("p1", cursor.getString(0))
            assertEquals("HIGH", cursor.getString(1))
        }
        migrated.query("SELECT contentMarkdown FROM notes WHERE id='n1'").use { cursor ->
            assertEquals(true, cursor.moveToFirst())
            assertEquals("[LEG-1] preserved", cursor.getString(0))
        }
        migrated.query("SELECT count(*) FROM outbox").use { cursor ->
            assertEquals(true, cursor.moveToFirst())
            assertEquals(1, cursor.getInt(0))
        }
        migrated.query("SELECT count(*) FROM conflicts").use { cursor ->
            assertEquals(true, cursor.moveToFirst())
            assertEquals(1, cursor.getInt(0))
        }
        migrated.query("SELECT value FROM sync_meta WHERE `key`='v2_protocol'").use { cursor ->
            assertEquals(true, cursor.moveToFirst())
            assertEquals("2", cursor.getString(0))
        }
        migrated.query("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('folders','task_steps','workflows','workflow_stages','workflow_task_memberships','archive_operations')").use { cursor ->
            var count = 0
            while (cursor.moveToNext()) count += 1
            assertEquals(6, count)
        }
        // v6 adds settings.weekStartsOn. A pre-existing settings row must keep
        // its identity and receive the column default rather than being dropped.
        migrated.query("SELECT weekStartsOn FROM settings WHERE ownerId='u1'").use { cursor ->
            assertEquals(true, cursor.moveToFirst())
            assertEquals(1, cursor.getInt(0))
        }
        assertNotNull(migrated)
        migrated.close()
    }

    @Test
    fun migrateV7ToV8AddsIndexesToDatabasesCreatedWithoutThem() {
        val databaseName = "taskdock-v7-no-indexes-fixture"
        helper.createDatabase(databaseName, 7).apply {
            listOf(
                "index_folders_ownerId_parentFolderId",
                "index_folders_ownerId_archivedAt",
                "index_task_steps_ownerId_taskId",
                "index_workflows_ownerId_archivedAt",
                "index_workflow_stages_ownerId_workflowId",
                "index_workflow_task_memberships_ownerId_workflowId",
                "index_workflow_task_memberships_ownerId_stageId",
            ).forEach { index -> execSQL("DROP INDEX IF EXISTS `$index`") }
            close()
        }

        val migrated = helper.runMigrationsAndValidate(
            databaseName,
            8,
            true,
            AppDatabase.MIGRATION_7_8,
        )
        migrated.query(
            "SELECT count(*) FROM sqlite_master WHERE type='index' AND name LIKE 'index_%'",
        ).use { cursor ->
            assertEquals(true, cursor.moveToFirst())
            assertEquals(7, cursor.getInt(0))
        }
        migrated.close()
    }
}
