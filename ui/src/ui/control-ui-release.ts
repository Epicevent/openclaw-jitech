// Injected by Vite at build time (see ui/vite.config.ts). True only when the UI
// bundle was produced by a release image build (OPENCLAW_BUILD_VERSION set); a
// local/dev `pnpm ui:build` — e.g. what a source-mount preview slot serves —
// leaves it false so the footer can show "개발" instead of a misleading version.
declare const OPENCLAW_CONTROL_UI_RELEASE: boolean | undefined;

export function controlUiIsReleaseBuild(): boolean {
  // Read the Vite define. It is absent (a bare ReferenceError) in unit tests and
  // any non-injected context; treat that as a release build so a real slot never
  // mislabels itself "개발". Only an injected `false` (a dev/source build) flips it.
  try {
    return OPENCLAW_CONTROL_UI_RELEASE ?? true;
  } catch {
    return true;
  }
}

/**
 * The sidebar footer text: a dev/source build shows a plain "개발"-style label
 * (its server version reflects neither the mounted dev UI nor a real release);
 * a release build shows `v<server version>`. Returns null when there is nothing
 * to show yet (release build, not connected).
 */
export function versionFooterText(
  version: string,
  isReleaseBuild: boolean,
  devLabel: string,
): string | null {
  if (!isReleaseBuild) {
    return devLabel;
  }
  return version ? `v${version}` : null;
}
