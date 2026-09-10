import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * `@touch4it/ical-timezones` loads its VTIMEZONE data with
   * `fs.readFileSync(path.join(__dirname, "zones", ...))`. Bundling it rewrites
   * `__dirname` into the build output, where those .ics files don't exist, and
   * the library reports the miss by returning null rather than throwing — so
   * every calendar silently loses its timezone block. Keeping it external means
   * it's required from node_modules at runtime with a correct `__dirname`.
   */
  serverExternalPackages: ["@touch4it/ical-timezones"],

  // Belt and braces for serverless targets, where only traced files are copied.
  outputFileTracingIncludes: {
    "/api/generate-ics": ["./node_modules/@touch4it/ical-timezones/zones/**"],
  },
};

export default nextConfig;
