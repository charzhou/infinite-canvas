import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";

import { createApp } from "./app.js";
import { loadOidcConfig } from "./config.js";

const webDist = resolve(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
const indexFile = resolve(webDist, "index.html");
const app = createApp(loadOidcConfig());

app.use(express.static(webDist));
app.use((request, response, next) => {
    if (request.path.startsWith("/api/")) return response.status(404).json({ code: "api_not_found" });
    if (request.method === "GET" && existsSync(indexFile)) return response.sendFile(indexFile);
    next();
});

const port = Number.parseInt(process.env.PORT || "3000", 10) || 3000;
app.listen(port, "0.0.0.0", () => console.log(`Infinite Canvas BFF listening on ${port}`));
