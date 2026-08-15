export function syncCourseResponse(result) {
  const response = {
    ok: true,
    manifest: result.manifest,
    revision: result.revision,
    course: result.course,
  };
  if (Array.isArray(result.warnings) && result.warnings.length) response.warnings = result.warnings;
  return response;
}
