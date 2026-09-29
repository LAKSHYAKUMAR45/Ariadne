/**
 * SQL scalar subquery for the version number of a source's current version: the version whose content hash equals
 * the source's `current_hash` (an A→B→A revert makes an older version current), falling back to the highest
 * version number when no version carries that hash.
 */
export function currentSourceVersionNumberSql(projectIdColumn: string, sourceIdColumn: string, currentHashColumn: string): string {
  return `COALESCE(
    (SELECT current_version.version_number FROM knowledge_source_versions current_version
      WHERE current_version.project_id = ${projectIdColumn}
        AND current_version.source_id = ${sourceIdColumn}
        AND current_version.content_hash = ${currentHashColumn}),
    (SELECT MAX(latest_version.version_number) FROM knowledge_source_versions latest_version
      WHERE latest_version.project_id = ${projectIdColumn} AND latest_version.source_id = ${sourceIdColumn})
  )`;
}
