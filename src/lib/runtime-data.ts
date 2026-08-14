import fs from "node:fs";
import { resolveDataPath } from "../../server/runtime-config.mjs";

export interface TextPageData { title: string; content: string }
export interface FooterData {
  enabled?: boolean;
  showVisitCount?: boolean;
  useRealVisitCount?: boolean;
  visitCount?: string | number;
  startedAt?: string;
  copyrightText?: string;
  copyrightYear?: string | number;
  maintainers?: Array<{ label?: string; url?: string }>;
}
export interface FeedbackData { title?: string; announcement?: string; rules?: Record<string, unknown>; items?: unknown[] }
export interface HomeData { announcement: string; [key: string]: unknown }
export interface LinkItem { name: string; url: string; description?: string; type?: string; hidden?: boolean }
export interface LinksData {
  title?: string;
  intro?: string;
  mutualTitle?: string;
  recommendedTitle?: string;
  siteInfoTitle?: string;
  links?: LinkItem[];
  siteInfo?: { name?: string; url?: string; description?: string };
}
export interface RuntimeDataMap {
  "about.json": TextPageData;
  "feedback.json": FeedbackData;
  "footer.json": FooterData;
  "home.json": HomeData;
  "links.json": LinksData;
  "participate.json": TextPageData;
}

export function readBuildData<K extends keyof RuntimeDataMap>(filename: K): RuntimeDataMap[K];
export function readBuildData<T>(filename: string): T;
export function readBuildData<T>(filename: string): T {
  const filePath = resolveDataPath(filename);
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Required build data is missing: ${filePath}`);
    }
    throw error;
  }
}
