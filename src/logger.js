function formatFields(fields = {}) {
  const parts = [];

  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) {
      continue;
    }

    if (value === null) {
      parts.push(`${key}=null`);
      continue;
    }

    if (typeof value === "string") {
      parts.push(`${key}=${value}`);
      continue;
    }

    parts.push(`${key}=${JSON.stringify(value)}`);
  }

  return parts.join(" ");
}

function emit(level, event, fields) {
  const prefix = `[${new Date().toISOString()}] ${level.toUpperCase()} ${event}`;
  const suffix = formatFields(fields);
  const line = suffix ? `${prefix} ${suffix}` : prefix;
  console.log(line);
}

export const logger = {
  info(event, fields) {
    emit("info", event, fields);
  },
  warn(event, fields) {
    emit("warn", event, fields);
  },
  error(event, fields) {
    emit("error", event, fields);
  }
};
