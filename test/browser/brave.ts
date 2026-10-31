export const braveExecutable =
  process.env.MULTIPI_BRAVE_EXECUTABLE ??
  (process.platform === "darwin"
    ? "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
    : "/usr/bin/brave-browser");
