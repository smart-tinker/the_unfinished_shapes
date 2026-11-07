# Shared world server

Use Node 24 on the operator's host. Define `WORLD_USERS_JSON` as a JSON object mapping private bearer tokens (at least 16 characters each) to `{ "id": "safe-unique-user-id", "role": "viewer|builder|admin" }`. Generate tokens using your normal secure process and share each only with its player. Do not commit them to Git or paste them into model prompts.

Set `WORLD_HOST=0.0.0.0` for a LAN server, `WORLD_PORT=4317`, and `WORLD_DATA_PATH` to a durable JSON file path. Run `npm run server`. Without an explicit users map the standalone server will refuse to start. In each desktop client's settings, enter the same server URL and the player's own token. External tokens are held in memory for the session, not saved in settings.

- `GET /state` returns revision, objects, players, known mechanics and the authenticated `me`.
- `POST /command` accepts build, remove or move commands, content type application/json.
- Both endpoints require `Authorization: Bearer <token>`.
- Build: `{ "type":"build", "objectType":"bridge", "position":{"x":0,"y":1,"z":0} }`.
- Remove: `{ "type":"remove", "id":"object-id" }`.
- Move: `{ "type":"move", "position":{"x":1,"y":0,"z":1} }`.

Builders remove only their own objects, admins any object, viewers cannot build/remove. Identity and role come from operator configuration. Bounds, body-size, world-size and request-rate limits apply. Unknown mechanics are rejected with `new_mechanic_required`.

Mutations are serialized and written atomically before becoming visible. Invalid/corrupt saved worlds stop startup rather than silently resetting. Keep one server process per data file. The prototype does not implement distributed locks, account registration, expiry/revocation UI or world migrations. Use TLS for networks you do not fully trust.
