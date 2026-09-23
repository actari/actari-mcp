// Тесты readEnv: сервер журнала читает только ACTARI_<name>.
import { test } from "node:test";
import assert from "node:assert/strict";

import { readEnv } from "../env.mjs";

test("readEnv: ACTARI_<name> читается", () => {
	assert.equal(readEnv("DB", { env: { ACTARI_DB: "/tmp/new.db" } }), "/tmp/new.db");
});

test("readEnv: без ACTARI_<name> — undefined, посторонние префиксы не читаются", () => {
	assert.equal(readEnv("DB", { env: { OTHER_DB: "/tmp/x.db" } }), undefined);
});
