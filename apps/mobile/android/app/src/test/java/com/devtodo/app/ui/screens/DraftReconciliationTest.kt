package com.devtodo.app.ui.screens

import org.junit.Assert.*
import org.junit.Test

class DraftReconciliationTest {
    @Test fun remoteRevisionUpdatesAnUntouchedField() {
        assertEquals(ReconciledDraft("new", "new", false), reconcileDraft("old", "old", "new"))
    }
    @Test fun remoteRevisionCannotReplaceAnUnsavedDraft() {
        assertEquals(ReconciledDraft("draft", "old", true), reconcileDraft("draft", "old", "remote"))
        assertEquals(ReconciledDraft("draft", "draft", false), reconcileDraft("draft", "old", "draft"))
    }
}
