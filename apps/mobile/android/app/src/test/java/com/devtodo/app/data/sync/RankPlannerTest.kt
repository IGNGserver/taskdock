package com.devtodo.app.data.sync

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RankPlannerTest {
    @Test
    fun adjacentGapRebalancesInRequestedDirection() {
        val plan = planSiblingRankMove(
            listOf(RankSibling("a", "1"), RankSibling("b", "2"), RankSibling("c", "3")),
            movingId = "c",
            beforeId = "b",
        )
        assertEquals("1024", plan["a"])
        assertEquals("2048", plan["c"])
        assertEquals("3072", plan["b"])
    }

    @Test
    fun duplicateRanksAlwaysProduceStrictRequestedOrder() {
        val original = listOf("a", "b", "c", "d").map { RankSibling(it, "1") }
        for (moving in original) {
            for (anchor in original) {
                if (moving.id == anchor.id) continue
                for (after in listOf(false, true)) {
                    val plan = planSiblingRankMove(
                        original,
                        moving.id,
                        beforeId = if (after) null else anchor.id,
                        afterId = if (after) anchor.id else null,
                    )
                    val expected = original.filterNot { it.id == moving.id }.toMutableList()
                    val anchorIndex = expected.indexOfFirst { it.id == anchor.id }
                    expected.add(anchorIndex + if (after) 1 else 0, moving)
                    val ranks = expected.map { (plan[it.id] ?: it.rank).toBigInteger() }
                    ranks.zipWithNext().forEach { (left, right) -> assertTrue(right > left) }
                }
            }
        }
    }

    @Test
    fun prependRebalancesInsteadOfEmittingNegativeRank() {
        val plan = planSiblingRankMove(
            listOf(RankSibling("a", "1"), RankSibling("b", "2048")),
            movingId = "b",
            beforeId = "a",
        )
        assertEquals(mapOf("b" to "1024", "a" to "2048"), plan)
        assertTrue(plan.values.all { it.toBigInteger() > java.math.BigInteger.ZERO })
    }

    @Test
    fun appendBeyondInt64DoesNotWrap() {
        assertEquals(
            "9223372036854776831",
            appendRank(listOf("1024", Long.MAX_VALUE.toString())),
        )
    }
}
