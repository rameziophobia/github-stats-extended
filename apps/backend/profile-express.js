import { createProfileApp } from "./profile-app.js";

const server = createProfileApp().listen(process.env.PORT || 9000, "0.0.0.0");
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 20_000).unref();
  });
}
