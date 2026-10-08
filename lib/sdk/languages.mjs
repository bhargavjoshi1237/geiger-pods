/**
 * SDK language registry (S13 part C).
 *
 * Native template generators (`javascript`, `typescript`, `python`) live in
 * this folder and are rendered from the stage export. Extended languages
 * (`java`, `android`, `swift`, `ruby`, `go`, `kotlin`) render a documented
 * OpenAPI Generator stub (see `workers/sdkgen/Dockerfile`, pinned version)
 * so the management API stays honest about the pipeline.
 *
 * @module lib/sdk/languages
 */

export const NATIVE_SDK_LANGUAGES = ["javascript", "typescript", "python"];

export const EXTENDED_SDK_LANGUAGES = ["java", "android", "swift", "ruby", "go", "kotlin"];

export const SUPPORTED_SDK_LANGUAGES = [...NATIVE_SDK_LANGUAGES, ...EXTENDED_SDK_LANGUAGES];

/**
 * Validates an SDK language name.
 *
 * @param {unknown} language
 * @returns {string}
 * @throws {Error} When unsupported.
 */
export function checkSdkLanguage(language) {
  if (typeof language !== "string" || !SUPPORTED_SDK_LANGUAGES.includes(language)) {
    throw Object.assign(
      new Error(`Unsupported SDK language "${String(language)}" (expected one of ${SUPPORTED_SDK_LANGUAGES.join(", ")}).`),
      { code: "invalid_language" },
    );
  }
  return language;
}

/**
 * Cleans the AWS-like SDK config (`packageName`, `version`, `className`).
 *
 * @param {object} [input={}]
 * @returns {{ packageName: string, version: string, className: string }}
 */
export function cleanSdkConfig(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const packageName = typeof source.packageName === "string" && source.packageName !== ""
    ? source.packageName.slice(0, 128)
    : "pods-client";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(packageName)) {
    throw Object.assign(new Error("Invalid $.config.packageName: 1–128 chars [A-Za-z0-9._-], leading alnum."), { code: "invalid_config" });
  }
  const version = typeof source.version === "string" && source.version !== ""
    ? source.version.slice(0, 32)
    : "0.1.0";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(version)) {
    throw Object.assign(new Error("Invalid $.config.version."), { code: "invalid_config" });
  }
  const rawClass = typeof source.className === "string" && source.className !== "" ? source.className : "PodsClient";
  const className = rawClass.slice(0, 64);
  if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(className)) {
    throw Object.assign(new Error("Invalid $.config.className: must start with a letter."), { code: "invalid_config" });
  }
  return { packageName, version, className };
}
