import packageJson from "../package.json" with { type: "json" };

export const APP_NAME = packageJson.name;
export const APP_VERSION = packageJson.version;
export const APP_DISPLAY_NAME = "PostOfficeX";

export function formatVersionLine() {
  return `${APP_NAME} ${APP_VERSION}`;
}
