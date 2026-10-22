package com.devtodo.app.data.update

/**
 * A small semantic-version implementation for release tags.
 *
 * Android's versionCode cannot distinguish `2.0.0-rc.53` from `2.0.0-rc.54`
 * (and historically did not), so the update decision must use versionName.
 * The comparison follows semver precedence: stable > prerelease, numeric
 * prerelease identifiers compare numerically, and consumers of a shorter
 * identifier list have lower precedence (`rc` < `rc.1`).
 */
class SemanticVersion private constructor(
    val major: Int,
    val minor: Int,
    val patch: Int,
    val preRelease: List<String>,
) : Comparable<SemanticVersion> {

    val isPrerelease: Boolean get() = preRelease.isNotEmpty()

    override fun compareTo(other: SemanticVersion): Int {
        major.compareTo(other.major).let { if (it != 0) return it }
        minor.compareTo(other.minor).let { if (it != 0) return it }
        patch.compareTo(other.patch).let { if (it != 0) return it }

        if (preRelease.isEmpty() && other.preRelease.isEmpty()) return 0
        if (preRelease.isEmpty()) return 1
        if (other.preRelease.isEmpty()) return -1

        val length = maxOf(preRelease.size, other.preRelease.size)
        for (index in 0 until length) {
            val left = preRelease.getOrNull(index) ?: return -1
            val right = other.preRelease.getOrNull(index) ?: return 1
            val leftNumber = left.toIntOrNull()
            val rightNumber = right.toIntOrNull()
            val compared = when {
                leftNumber != null && rightNumber != null -> leftNumber.compareTo(rightNumber)
                leftNumber != null -> -1
                rightNumber != null -> 1
                else -> left.compareTo(right)
            }
            if (compared != 0) return compared
        }
        return 0
    }

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is SemanticVersion) return false
        return major == other.major &&
            minor == other.minor &&
            patch == other.patch &&
            preRelease == other.preRelease
    }

    override fun hashCode(): Int {
        var result = major
        result = 31 * result + minor
        result = 31 * result + patch
        result = 31 * result + preRelease.hashCode()
        return result
    }

    override fun toString(): String = buildString {
        append(major).append('.').append(minor).append('.').append(patch)
        if (preRelease.isNotEmpty()) preRelease.joinTo(this, ".", prefix = "-")
    }

    companion object {
        private val pattern = Regex("""^[vV]?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$""")

        fun parse(raw: String?): SemanticVersion? {
            val value = raw?.trim().orEmpty()
            if (value.isEmpty()) return null
            val match = pattern.matchEntire(value) ?: return null
            val major = match.groupValues[1].toIntOrNull() ?: return null
            val minor = match.groupValues[2].toIntOrNull() ?: return null
            val patch = match.groupValues[3].toIntOrNull() ?: return null
            val prerelease = match.groupValues[4]
                .takeIf { it.isNotEmpty() }
                ?.split('.')
                ?.filter { it.isNotEmpty() }
                ?: emptyList()
            return SemanticVersion(major, minor, patch, prerelease)
        }
    }
}
