package com.devtodo.app.data.local

import android.database.sqlite.SQLiteDatabase
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.math.BigInteger
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class RankSqlTest {
    @Test
    fun decimalOrderMatchesBigIntegerBeyondInt64() {
        val rows = listOf(
            "-${BigInteger.ONE.shiftLeft(80)}" to "negative-huge",
            "-1024" to "negative-1024",
            "-0002" to "negative-2",
            "0" to "zero",
            "0001" to "one",
            "1024" to "1024",
            Long.MAX_VALUE.toString() to "int64-max",
            BigInteger.ONE.shiftLeft(63).toString() to "int64-plus-1",
            BigInteger.ONE.shiftLeft(63).add(BigInteger.valueOf(1024)).toString() to "int64-plus-1025",
            BigInteger.ONE.shiftLeft(80).toString() to "positive-huge",
        ).shuffled(kotlin.random.Random(7))
        val db = SQLiteDatabase.create(null)
        try {
            for ((table, order) in listOf("ranks" to RANK_ORDER, "placements" to PLACEMENT_RANK_ORDER)) {
                db.execSQL("CREATE TABLE $table (rank TEXT NOT NULL, id TEXT NOT NULL)")
                rows.forEach { (rank, id) ->
                    db.execSQL("INSERT INTO $table (rank, id) VALUES (?, ?)", arrayOf(rank, id))
                }
                val actual = mutableListOf<Pair<String, String>>()
                db.rawQuery("SELECT rank, id FROM $table ORDER BY $order, id", null).use { cursor ->
                    while (cursor.moveToNext()) actual += cursor.getString(0) to cursor.getString(1)
                }
                val expected = rows.sortedWith(
                    compareBy<Pair<String, String>> { BigInteger(it.first) }.thenBy { it.second },
                )
                assertEquals(table, expected, actual)
            }
        } finally {
            db.close()
        }
    }
}
