/**
 * A versioned keyring of 32-byte server secrets, read from two environment
 * variables and validated at first use: an active key id, the retained keys,
 * and generation ordering so a consumer can tell "hashed under an older key"
 * from "hashed under the current one". Every keyring binds to this one parser,
 * so no copy of the rules can quietly accept what another rejects.
 *
 * Parameterised by env var NAMES, so a failure names the variable an operator
 * has to fix.
 *
 * **No secret, and no slice of one, may appear in an error message here**:
 * startup logs are widely readable. Errors name the key ID, which every hash
 * envelope stores anyway.
 */

/** Key IDs travel inside hash envelopes, so they must stay envelope-safe. */
export const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
/** Unpadded base64url of exactly 32 bytes. */
export const BASE64URL_32_BYTES_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** Every retained key is usable by whoever obtains the environment. */
const MAX_KEYS = 8;
const MAX_GENERATION = 2_147_483_647;

interface KeyMaterial {
  generation: number;
  secret: Buffer;
}

interface KeyringKey {
  id: string;
  generation: number;
  secret: Buffer;
}

interface KeyringConfiguration {
  activeId: string;
  keys: ReadonlyMap<string, KeyMaterial>;
}

/** One class for every keyring: a fatal misconfiguration nothing catches by type. */
class KeyringConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyringConfigurationError';
  }
}

interface KeyringSpec {
  /** Env var holding the active key ID. */
  activeIdEnv: string;
  /** Env var holding the JSON keyring. */
  keyringEnv: string;
  /** Human-readable name for error messages, e.g. `password pepper`. */
  label: string;
}

/**
 * A lazily-parsed keyring. `validate()` exists so `lib/env.server.ts` can force
 * the parse at startup instead of letting the first request discover the problem.
 */
interface Keyring {
  validate: () => void;
  active: () => KeyringKey;
  byId: (id: string) => KeyringKey;
}

export function defineKeyring(spec: KeyringSpec): Keyring {
  const cache: { configuration: KeyringConfiguration | undefined } = {
    configuration: undefined,
  };

  function fail(message: string): never {
    throw new KeyringConfigurationError(
      `Invalid ${spec.label} configuration: ${message}`
    );
  }

  function readRequiredEnv(name: string): string {
    const value = process.env[name];
    if (!value) fail(`${name} is required`);
    return value;
  }

  function decodeSecret(id: string, encoded: unknown): Buffer {
    if (
      typeof encoded !== 'string' ||
      !BASE64URL_32_BYTES_PATTERN.test(encoded)
    )
      fail(
        `key "${id}" must be an unpadded base64url encoding of exactly 32 bytes`
      );

    const decoded = Buffer.from(encoded, 'base64url');
    // Re-encoded and compared, not just length-checked: decoding ignores non-zero
    // trailing bits in the final character, so two strings can decode to one key.
    if (decoded.length !== 32 || decoded.toString('base64url') !== encoded)
      fail(
        `key "${id}" must be an unpadded base64url encoding of exactly 32 bytes`
      );

    return decoded;
  }

  function parseMaterial(id: string, value: unknown): KeyMaterial {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      fail(`key "${id}" must be a JSON object`);

    const entry = value as Record<string, unknown>;
    const fields = Object.keys(entry);
    // Exactly these two: a misspelt field would otherwise be ignored silently.
    if (
      fields.length !== 2 ||
      !Object.hasOwn(entry, 'generation') ||
      !Object.hasOwn(entry, 'secret')
    )
      fail(`key "${id}" must contain only "generation" and "secret"`);

    const { generation } = entry;
    if (
      typeof generation !== 'number' ||
      !Number.isSafeInteger(generation) ||
      generation < 1 ||
      generation > MAX_GENERATION
    )
      fail(
        `key "${id}" generation must be an integer between 1 and ${MAX_GENERATION}`
      );

    return { generation, secret: decodeSecret(id, entry.secret) };
  }

  function parseConfiguration(): KeyringConfiguration {
    const activeId = readRequiredEnv(spec.activeIdEnv);
    if (!KEY_ID_PATTERN.test(activeId))
      fail(`${spec.activeIdEnv} must match ${KEY_ID_PATTERN.source}`);

    const encodedKeyring = readRequiredEnv(spec.keyringEnv);
    let rawKeyring: unknown;
    try {
      rawKeyring = JSON.parse(encodedKeyring);
    } catch {
      fail(`${spec.keyringEnv} must be a valid JSON object`);
    }

    if (
      typeof rawKeyring !== 'object' ||
      rawKeyring === null ||
      Array.isArray(rawKeyring)
    )
      fail(`${spec.keyringEnv} must be a JSON object`);

    const entries = Object.entries(rawKeyring);
    if (entries.length === 0 || entries.length > MAX_KEYS)
      fail(`${spec.keyringEnv} must contain between 1 and ${MAX_KEYS} keys`);

    const keys = new Map<string, KeyMaterial>();
    const generations = new Map<number, string>();
    for (const [id, value] of entries) {
      if (!KEY_ID_PATTERN.test(id))
        fail(`key ID "${id}" must match ${KEY_ID_PATTERN.source}`);

      const material = parseMaterial(id, value);
      // Generation decides "is this hash stale", so two keys sharing one makes
      // that question unanswerable.
      const owner = generations.get(material.generation);
      if (owner)
        fail(
          `keys "${owner}" and "${id}" cannot share generation ${material.generation}`
        );

      generations.set(material.generation, id);
      keys.set(id, material);
    }

    if (!keys.has(activeId))
      fail(
        `${spec.activeIdEnv} must identify a key present in ${spec.keyringEnv}`
      );

    // `generation` is read as staleness (`needsRehash` in `password/hash.ts`),
    // so the active key must own the highest one.
    const activeGeneration = keys.get(activeId)?.generation ?? 0;
    const newest = Math.max(
      ...keys.values().map((material) => material.generation)
    );
    if (activeGeneration < newest)
      fail(
        `${spec.activeIdEnv} names key "${activeId}" (generation ${activeGeneration}), ` +
          `but ${spec.keyringEnv} contains generation ${newest}. The active key must own the ` +
          'highest generation, or every hash written with the newer key is treated as ' +
          'current forever. Roll the keyring and the active id together.'
      );

    return { activeId, keys };
  }

  function getConfiguration(): KeyringConfiguration {
    cache.configuration ??= parseConfiguration();
    return cache.configuration;
  }

  return {
    validate() {
      getConfiguration();
    },

    active() {
      const configuration = getConfiguration();
      const material = configuration.keys.get(configuration.activeId);
      if (!material)
        fail(
          `${spec.activeIdEnv} must identify a key present in ${spec.keyringEnv}`
        );
      return { id: configuration.activeId, ...material };
    },

    byId(id: string) {
      const material = getConfiguration().keys.get(id);
      if (!material) fail(`no key is configured for stored key ID "${id}"`);
      return { id, ...material };
    },
  };
}
