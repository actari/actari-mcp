// Чтение переменных окружения сервера журнала: только ACTARI_<name>.
export const ENV_PREFIX = "ACTARI_";

export function readEnv(name, { env = process.env } = {}) {
	return env[`${ENV_PREFIX}${name}`];
}
