// Minimal timestamped logger. stdout/stderr are captured by the LaunchAgent into
// $MEETINGS_BASE/logs/daemon.{out,err}.log. No dependencies.

function ts(): string {
  // Local time, second precision — matches the format used in process-failures.log.
  return new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

function line(level: string, component: string, msg: string): string {
  return `[${ts()}] ${level.padEnd(5)} ${component} — ${msg}`;
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
