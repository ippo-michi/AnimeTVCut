export type SubtitleSourceFormat = "srt" | "webvtt" | "ass" | "ssa";
export type SubtitleOutputFormat = "webvtt" | "ass";

export interface SubtitleEvent {
  start: number;
  end: number;
  text: string;
  sourceEpisodeId: string;
  sourceEpisodeOrder: number;
  sourceEventOrder: number;
  cueId?: string;
  settings?: string;
  assFields?: Readonly<Record<string, string>>;
}

export interface ParsedPlainSubtitle {
  format: "srt" | "webvtt";
  events: readonly SubtitleEvent[];
}

export interface AssStyle {
  name: string;
  fields: readonly string[];
}
export interface ParsedAssSubtitle {
  format: "ass" | "ssa";
  playResX?: number;
  playResY?: number;
  styleFormat: readonly string[];
  styles: readonly AssStyle[];
  eventFormat: readonly string[];
  events: readonly SubtitleEvent[];
  scriptInfo: readonly string[];
  attachments: readonly string[];
}
export type ParsedSubtitle = ParsedPlainSubtitle | ParsedAssSubtitle;

export interface DiscoveredSubtitle {
  episodeId: string;
  id: string;
  url: string;
  lang: string;
  source: "stream" | "subtitle_resource";
  formatHint?: SubtitleSourceFormat;
}
export type SubtitleFamilyMethod = "exact_id" | "unique_language";
export interface SubtitleFamily {
  lang: string;
  familyMethod: SubtitleFamilyMethod;
  outputFormat: SubtitleOutputFormat;
  sources: readonly DiscoveredSubtitle[];
}
export type SubtitleFamilyIssueReason =
  | "ambiguous_subtitle_family"
  | "incomplete_family"
  | "unsupported_format"
  | "format_family_mismatch";
export interface SubtitleFamilyIssue {
  lang: string;
  reason: SubtitleFamilyIssueReason;
}
