import { readBuildData } from "./runtime-data";

export type ResourceFile = {
  title: string;
  path: string;
  size?: number;
  description?: string;
};

export type ResourceSection = {
  title: string;
  note?: string;
  collapsed?: boolean;
  files: ResourceFile[];
};

export type Course = {
  uid: string;
  id: string;
  term: string;
  group: string;
  title: string;
  summary: string;
  source?: string;
  contributors?: string[];
  assessment?: string;
  hiddenMetaTags?: string[];
  updated: string;
  grades?: string[];
  tags?: string[];
  basePath: string;
  sections: ResourceSection[];
};

type Manifest = {
  version: number;
  updated: string;
  repository: string;
  resourceRoot: string;
  hiddenMetaTags?: string[];
  courses: Course[];
};

export const manifest = readBuildData<Manifest>("manifest.json");
export const courses = manifest.courses;

export const repositoryUrl = `https://github.com/${manifest.repository}`;
export const openListUrl = "https://pan.shview.top";

export function isHiddenResource(file: ResourceFile) {
  const text = `${file.title ?? ""}/${file.path ?? ""}`.toLowerCase();
  return text.includes(".openlist");
}

export function visibleFiles(files: ResourceFile[] = []) {
  return files.filter((file) => !isHiddenResource(file));
}

export function countFiles(course: Course) {
  return course.sections.reduce((sum, section) => sum + visibleFiles(section.files).length, 0);
}

export function totalSize(course: Course) {
  return course.sections.reduce((sum, section) => {
    return sum + visibleFiles(section.files).reduce((inner, file) => inner + (file.size ?? 0), 0);
  }, 0);
}

export function formatBytes(bytes = 0) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function encodePath(path: string) {
  return path
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
}

export function fileUrl(course: Course, file: ResourceFile) {
  return `${manifest.resourceRoot}${encodePath(course.basePath)}/${encodePath(file.path)}`;
}

export function coursePath(course: Course) {
  return `/courses/${encodeURIComponent(course.id)}/`;
}

export function terms() {
  return Array.from(new Set(courses.map((course) => course.term)));
}

export function groups() {
  return Array.from(new Set(courses.map((course) => course.group)));
}
