package com.devtodo.app.data.local

/*
 * SQLite CAST AS INTEGER saturates beyond INT64. Compare canonical decimal
 * strings by sign, significant digit count and digits instead. Signed input is
 * accepted for legacy local rows; newly planned ranks are positive integers.
 */
private const val UNSIGNED_RANK =
    "CASE WHEN ltrim(rank, '0') = '' THEN '0' ELSE ltrim(rank, '0') END"
private const val NEGATIVE_RANK =
    "CASE WHEN ltrim(substr(rank, 2), '0') = '' THEN '0' ELSE ltrim(substr(rank, 2), '0') END"

const val RANK_ORDER =
    "CASE WHEN rank GLOB '-[0-9]*' THEN 0 ELSE 1 END ASC, " +
        "CASE WHEN rank GLOB '-[0-9]*' THEN -length($NEGATIVE_RANK) ELSE length($UNSIGNED_RANK) END ASC, " +
        "CASE WHEN rank GLOB '-[0-9]*' THEN $NEGATIVE_RANK END DESC, " +
        "CASE WHEN rank NOT GLOB '-[0-9]*' THEN $UNSIGNED_RANK END"

private const val UNSIGNED_PLACEMENT_RANK =
    "CASE WHEN ltrim(placements.rank, '0') = '' THEN '0' ELSE ltrim(placements.rank, '0') END"
private const val NEGATIVE_PLACEMENT_RANK =
    "CASE WHEN ltrim(substr(placements.rank, 2), '0') = '' THEN '0' ELSE ltrim(substr(placements.rank, 2), '0') END"

const val PLACEMENT_RANK_ORDER =
    "CASE WHEN placements.rank GLOB '-[0-9]*' THEN 0 ELSE 1 END ASC, " +
        "CASE WHEN placements.rank GLOB '-[0-9]*' THEN -length($NEGATIVE_PLACEMENT_RANK) ELSE length($UNSIGNED_PLACEMENT_RANK) END ASC, " +
        "CASE WHEN placements.rank GLOB '-[0-9]*' THEN $NEGATIVE_PLACEMENT_RANK END DESC, " +
        "CASE WHEN placements.rank NOT GLOB '-[0-9]*' THEN $UNSIGNED_PLACEMENT_RANK END"
