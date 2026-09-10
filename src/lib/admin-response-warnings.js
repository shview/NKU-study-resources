export function responseWarnings(data) {
  return [data?.warnings, data?.cleanupWarnings]
    .flatMap((warnings) => Array.isArray(warnings) ? warnings : [])
    .filter((warning) => typeof warning === "string" && warning);
}

export function statusWithWarnings(message, data) {
  const warnings = responseWarnings(data);
  return warnings.length ? `${message}；警告：${warnings.join("；")}` : message;
}

export function r2SyncStatus(message, data) {
  const report = data?.report;
  if (!report) return statusWithWarnings(message, data);
  const parts = [];
  if (typeof report.addedCourses === "number" && report.addedCourses > 0) parts.push(`新增课程 ${report.addedCourses}`);
  if (typeof report.placeholderShells === "number" && report.placeholderShells > 0) parts.push(`其中空资料课程壳 ${report.placeholderShells} 个（资料上传后再重建即并入）`);
  if (typeof report.placeholderSkipped === "number" && report.placeholderSkipped > 0) parts.push(`跳过E课纯占位目录 ${report.placeholderSkipped} 个`);
  if (typeof report.updatedCourses === "number" && report.updatedCourses > 0) parts.push(`更新课程 ${report.updatedCourses}`);
  if (typeof report.addedResources === "number" && report.addedResources > 0) parts.push(`新增资源 ${report.addedResources}`);
  if (typeof report.updatedResources === "number" && report.updatedResources > 0) parts.push(`更新资源 ${report.updatedResources}`);
  if (typeof report.added === "number" && typeof report.updated === "number" && parts.length === 0) parts.push(`新增资源 ${report.added}，更新资源 ${report.updated}`);
  const conflictCount = Array.isArray(report.conflicts) ? report.conflicts.length : 0;
  if (conflictCount > 0) parts.push(`路径冲突 ${conflictCount} 个`);
  return statusWithWarnings(parts.length ? `${message}：${parts.join("，")}` : message, data);
}
