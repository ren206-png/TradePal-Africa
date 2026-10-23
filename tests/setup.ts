import http from "node:http";
import https from "node:https";

/**
 * Node reuses idle client connections by default. Many tests hand supertest an Express app, which starts a throw-away server on a random port
 * for each request and closes it afterwards; a later request can then be sent down a kept-alive connection to a server that is already gone,
 * and fails with "socket hang up" (about one full run in four on a busy machine). Opening a fresh connection per request removes that class
 * of flake. Test tooling only: production code is untouched.
 */
http.globalAgent = new http.Agent({ keepAlive: false });
https.globalAgent = new https.Agent({ keepAlive: false });
