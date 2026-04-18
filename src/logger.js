function emit(level, event, fields) {
  const payload = {
    ts: new Date().toISOString(),
    level,
    event,
    ...fields
  };
  console.log(JSON.stringify(payload));
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
