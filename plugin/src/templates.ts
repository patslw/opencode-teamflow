import { VersionSchema, type WorkflowVersion } from "../../packages/protocol/src/index.js";
import { validateVersion } from "./model.js";

/** Portable immutable version, including the complete role/prompt/Skill references. */
export function exportTemplate(version: WorkflowVersion): string {
  return JSON.stringify(validateVersion(version), null, 2);
}
export function parseTemplate(source: string): WorkflowVersion {
  return validateVersion(VersionSchema.parse(JSON.parse(source)));
}
