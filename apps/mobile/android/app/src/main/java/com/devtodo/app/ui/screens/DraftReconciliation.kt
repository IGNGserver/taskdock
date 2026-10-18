package com.devtodo.app.ui.screens

/** Rebase only untouched fields; a remote update must never replace a user's draft. */
data class ReconciledDraft(val value: String, val baseline: String?, val conflict: Boolean)

fun reconcileDraft(value: String, baseline: String?, remote: String): ReconciledDraft = when {
    baseline == null || value == baseline || value == remote -> ReconciledDraft(remote, remote, false)
    else -> ReconciledDraft(value, baseline, remote != baseline)
}
