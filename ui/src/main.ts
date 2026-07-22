import "./styles.css";
import { installClientErrorReporter } from "./ui/client-error-reporter.ts";
import "./ui/app.ts";

// Register global error listeners before the app boots so early crashes are captured.
installClientErrorReporter();

type ViteImportMeta = ImportMeta & {
  readonly env?: {
    readonly PROD?: boolean;
  };
};

declare const OPENCLAW_CONTROL_UI_BUILD_ID: string | undefined;

const isProd = (import.meta as ViteImportMeta).env?.PROD === true;

if (isProd && "serviceWorker" in navigator) {
  const swUrl = new URL("./sw.js", window.location.href);
  swUrl.searchParams.set("v", OPENCLAW_CONTROL_UI_BUILD_ID || "dev");
  void navigator.serviceWorker.register(swUrl, { updateViaCache: "none" });
} else if (!isProd && "serviceWorker" in navigator) {
  // Unregister any leftover dev SW to avoid stale cache issues.
  void navigator.serviceWorker.getRegistrations().then((registrations) => {
    for (const r of registrations) {
      void r.unregister();
    }
  });
}
