// Minimal timestamped logger. stdout/stderr are captured by the LaunchAgent into
// $MEETINGS_BASE/logs/daemon.{out,err}.log. No dependencies.

/** Timestamp for a log line (UTC, second precision: "YYYY-MM-DD HH:MM:SS").
 *  Shared with process-failures.log so the two stay in the same format. */
export function isoStamp(): string {
  return new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

function line(level: string, component: string, msg: string): string {
  return `[${isoStamp()}] ${level.padEnd(5)} ${component} — ${msg}`;
}

export const log = {
  info(component: string, msg: string) {
    console.log(line("INFO", component, msg));
  },
  warn(component: string, msg: string) {
    console.warn(line("WARN", component, msg));
  },
  error(component: string, msg: string) {
    console.error(line("ERROR", component, msg));
  },
};
