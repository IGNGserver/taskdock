package com.devtodo.app.data.sync

import java.math.BigInteger

data class RankSibling(val id: String, val rank: String)

private val rankStep = BigInteger.valueOf(1024)
private val int64Max = BigInteger.ONE.shiftLeft(63).subtract(BigInteger.ONE)

fun appendRank(ranks: Iterable<String>): String =
    ((ranks.maxOfOrNull { it.toBigInteger() } ?: BigInteger.ZERO) + rankStep).toString()

/** Numeric comparison without overflowing PostgreSQL's INT64 rank boundary. */
fun rankValue(rank: String): BigInteger = rank.toBigInteger()

/** Must match planSiblingRankMove in packages/domain. Input is canonically ordered. */
fun planSiblingRankMove(
    siblings: List<RankSibling>,
    movingId: String,
    beforeId: String? = null,
    afterId: String? = null,
): Map<String, String> {
    val moving = siblings.firstOrNull { it.id == movingId }
        ?: throw IllegalArgumentException("排序节点不存在")
    require(beforeId != movingId && afterId != movingId) { "排序锚点已变化" }
    val remaining = siblings.filterNot { it.id == movingId }
    val anchorId = beforeId ?: afterId
    val anchorIndex = anchorId?.let { id -> remaining.indexOfFirst { it.id == id } } ?: -1
    require(anchorId == null || anchorIndex >= 0) { "排序锚点已变化" }
    val insertionIndex = if (anchorId == null) remaining.size else anchorIndex + if (afterId != null) 1 else 0
    val lower = remaining.getOrNull(insertionIndex - 1)?.rank?.toBigInteger()
    val upper = remaining.getOrNull(insertionIndex)?.rank?.toBigInteger()
    val desired = when {
        lower == null && upper == null -> rankStep
        upper == null -> lower!! + rankStep
        lower == null -> upper - rankStep
        upper - lower > BigInteger.ONE -> lower + (upper - lower) / BigInteger.valueOf(2)
        else -> null
    }
    val hasInvalidOrder = remaining.withIndex().any { (index, row) ->
        index > 0 && row.rank.toBigInteger() <= remaining[index - 1].rank.toBigInteger()
    }
    if (!hasInvalidOrder && desired != null && desired > BigInteger.ZERO && desired <= int64Max) {
        return mapOf(movingId to desired.toString())
    }

    val ordered = remaining.toMutableList()
    ordered.add(insertionIndex, moving)
    val plan = mutableMapOf<String, String>()
    ordered.forEachIndexed { index, row ->
        val rank = BigInteger.valueOf(index + 1L) * rankStep
        if (rank.toString() != row.rank) plan[row.id] = rank.toString()
    }
    return plan
}
