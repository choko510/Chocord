/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { managedStyleRootNode } from "@api/Styles";
import { createAndAppendStyle } from "@utils/css";
import { Logger } from "@utils/Logger";
import { find, findAll, findCssClasses, findStore } from "@webpack";
import * as WebpackCommon from "@webpack/common";
import { Alerts, React, showToast, Toasts, useStateFromStores } from "@webpack/common";

type BdFilter = (module: unknown) => boolean;

interface BdBulkQuery {
    filter?: BdFilter;
    defaultExport?: boolean;
    searchDefault?: boolean;
}

interface BdFindInTreeOptions {
    walkable?: string[];
}

interface BdApiStyleManager {
    addStyle(id: string, css: string): void;
    removeStyle(id: string): void;
    clear(): void;
}

type SerializableRequestInit = Pick<RequestInit, "headers" | "method">;

interface NativeFetchResponse {
    data: ArrayBuffer;
    headers: Record<string, string>;
    ok: boolean;
    status: number;
    statusText: string;
}

interface NativeFetchHelper {
    fetchFile?(url: string, init?: SerializableRequestInit): Promise<NativeFetchResponse>;
}

const legacyWebpackKeyAliases: Readonly<Record<string, readonly string[]>> = Object.freeze({
    threadMessageAccessoryContentLeadingIcon: ["messageContent"]
});

const memoryStorage = (() => {
    const values = new Map<string, string>();

    return {
        get length() {
            return values.size;
        },
        clear() {
            values.clear();
        },
        getItem(key: string) {
            return values.get(String(key)) ?? null;
        },
        key(index: number) {
            return [...values.keys()][index] ?? null;
        },
        removeItem(key: string) {
            values.delete(String(key));
        },
        setItem(key: string, value: string) {
            values.set(String(key), String(value));
        }
    } as Storage;
})();

function resolveLocalStorage() {
    if (typeof window === "undefined") return memoryStorage;

    try {
        const storage = window.localStorage;
        if (
            storage &&
            typeof storage.getItem === "function" &&
            typeof storage.setItem === "function" &&
            typeof storage.removeItem === "function"
        ) {
            return storage;
        }
        return memoryStorage;
    } catch {
        return memoryStorage;
    }
}

function toHeaderRecord(headers: HeadersInit | undefined) {
    if (!headers) return undefined;
    if (headers instanceof Headers) return Object.fromEntries(headers.entries());
    if (Array.isArray(headers)) return Object.fromEntries(headers);
    return headers;
}

function toSerializableRequestInit(init?: RequestInit): SerializableRequestInit | undefined {
    if (!init) return undefined;

    return {
        method: init.method,
        headers: toHeaderRecord(init.headers)
    };
}

class CompatEventEmitter {
    private listeners = new Map<string | symbol, Set<(...args: unknown[]) => void>>();

    addListener(event: string | symbol, listener: (...args: unknown[]) => void) {
        const handlers = this.listeners.get(event) ?? new Set<(...args: unknown[]) => void>();
        handlers.add(listener);
        this.listeners.set(event, handlers);
        return this;
    }

    on(event: string | symbol, listener: (...args: unknown[]) => void) {
        return this.addListener(event, listener);
    }

    once(event: string | symbol, listener: (...args: unknown[]) => void) {
        const wrapped = (...args: unknown[]) => {
            this.removeListener(event, wrapped);
            listener(...args);
        };

        return this.addListener(event, wrapped);
    }

    removeListener(event: string | symbol, listener: (...args: unknown[]) => void) {
        const handlers = this.listeners.get(event);
        if (!handlers) return this;

        handlers.delete(listener);
        if (!handlers.size) this.listeners.delete(event);
        return this;
    }

    off(event: string | symbol, listener: (...args: unknown[]) => void) {
        return this.removeListener(event, listener);
    }

    removeAllListeners(event?: string | symbol) {
        if (event === undefined) {
            this.listeners.clear();
            return this;
        }

        this.listeners.delete(event);
        return this;
    }

    emit(event: string | symbol, ...args: unknown[]) {
        const handlers = this.listeners.get(event);
        if (!handlers?.size) return false;

        for (const handler of [...handlers]) {
            handler(...args);
        }

        return true;
    }
}

const compatRequireBuiltins = Object.freeze({
    events: Object.freeze({ EventEmitter: CompatEventEmitter })
});

function createLegacyRequireShim(pluginName: string, logger: Logger) {
    const nativeRequire = typeof window !== "undefined" && typeof window.require === "function"
        ? window.require.bind(window)
        : null;

    return (id: string) => {
        const normalizedId = String(id);

        if (normalizedId in compatRequireBuiltins) {
            return compatRequireBuiltins[normalizedId as keyof typeof compatRequireBuiltins];
        }

        if (nativeRequire) return nativeRequire(normalizedId);

        const error = new Error(`Legacy plugin requested unsupported module "${normalizedId}".`);
        logger.error(error);
        throw error;
    };
}

class CompatStyleManager implements BdApiStyleManager {
    private styles = new Map<string, HTMLStyleElement>();

    constructor(private readonly prefix: string) { }

    addStyle(id: string, css: string) {
        this.removeStyle(id);
        const style = createAndAppendStyle(`bd-${this.prefix}-${id}`, managedStyleRootNode);
        style.textContent = css;
        this.styles.set(id, style);
    }

    removeStyle(id: string) {
        const style = this.styles.get(id);
        style?.remove();
        this.styles.delete(id);
    }

    clear() {
        for (const style of this.styles.values()) style.remove();
        this.styles.clear();
    }
}

type BdPatchCallback = (thisValue: unknown, args: unknown[], result?: unknown) => unknown;
type Unpatch = () => void;

class CompatPatcher {
    private readonly unpatches = new Set<Unpatch>();

    constructor(private readonly logger: Logger) { }

    private findPropertyDescriptor(target: Record<string, unknown>, method: string) {
        let current: object | null = target;
        while (current) {
            const descriptor = Object.getOwnPropertyDescriptor(current, method);
            if (descriptor) {
                return {
                    owner: current as Record<string, unknown>,
                    descriptor
                };
            }
            current = Object.getPrototypeOf(current);
        }
        return null;
    }

    private patch(kind: "after" | "before" | "instead", args: unknown[]) {
        const offset = typeof args[0] === "string" ? 1 : 0;
        const target = args[offset] as Record<string, unknown> | undefined;
        const method = args[offset + 1] as string | undefined;
        const callback = args[offset + 2] as BdPatchCallback | undefined;

        if (!target || typeof target !== "object" || !method || typeof callback !== "function") {
            this.logger.warn("Invalid BetterDiscord patch call.");
            return () => void 0;
        }

        const original = target[method];
        if (typeof original !== "function") {
            this.logger.warn(`Cannot patch missing function "${method}".`);
            return () => void 0;
        }

        const originalFn = original as (...args: unknown[]) => unknown;
        const patched = function (this: unknown, ...patchArgs: unknown[]) {
            if (kind === "before") {
                try {
                    callback(this, patchArgs);
                } catch (error) {
                    logger.error(`Error in before patch for ${method}`, error);
                }
                return originalFn.apply(this, patchArgs);
            }

            if (kind === "instead") {
                const callOriginal = (...nextArgs: unknown[]) =>
                    originalFn.apply(this, nextArgs.length ? nextArgs : patchArgs);

                try {
                    return callback(this, patchArgs, callOriginal);
                } catch (error) {
                    logger.error(`Error in instead patch for ${method}`, error);
                    return callOriginal();
                }
            }

            const result = originalFn.apply(this, patchArgs);
            try {
                const patchedResult = callback(this, patchArgs, result);
                return patchedResult === undefined ? result : patchedResult;
            } catch (error) {
                logger.error(`Error in after patch for ${method}`, error);
                return result;
            }
        };

        const { logger } = this;
        let unpatch: Unpatch;
        const ownDescriptor = Object.getOwnPropertyDescriptor(target, method);

        try {
            target[method] = patched;
            unpatch = () => {
                if (target[method] === patched) target[method] = originalFn;
                this.unpatches.delete(unpatch);
            };
        } catch (assignmentError) {
            const foundDescriptor = this.findPropertyDescriptor(target, method);

            try {
                Object.defineProperty(target, method, {
                    configurable: true,
                    enumerable: foundDescriptor?.descriptor.enumerable ?? true,
                    writable: true,
                    value: patched
                });
            } catch (targetDefineError) {
                if (!foundDescriptor?.descriptor.configurable) {
                    this.logger.error(
                        `Failed to install BetterDiscord patch for read-only export "${method}".`,
                        { assignmentError, targetDefineError }
                    );
                    return () => void 0;
                }

                try {
                    Object.defineProperty(foundDescriptor.owner, method, {
                        configurable: true,
                        enumerable: foundDescriptor.descriptor.enumerable ?? true,
                        writable: true,
                        value: patched
                    });
                } catch (ownerDefineError) {
                    this.logger.error(
                        `Failed to install BetterDiscord patch for read-only export "${method}".`,
                        { assignmentError, targetDefineError, ownerDefineError }
                    );
                    return () => void 0;
                }

                unpatch = () => {
                    Object.defineProperty(foundDescriptor.owner, method, foundDescriptor.descriptor);
                    this.unpatches.delete(unpatch);
                };

                this.unpatches.add(unpatch);
                return unpatch;
            }

            unpatch = () => {
                if (ownDescriptor) {
                    Object.defineProperty(target, method, ownDescriptor);
                } else {
                    delete target[method];
                }
                this.unpatches.delete(unpatch);
            };
        }

        this.unpatches.add(unpatch);
        return unpatch;
    }

    after(...args: unknown[]) {
        return this.patch("after", args);
    }

    before(...args: unknown[]) {
        return this.patch("before", args);
    }

    instead(...args: unknown[]) {
        return this.patch("instead", args);
    }

    unpatchAll() {
        for (const unpatch of [...this.unpatches]) {
            try {
                unpatch();
            } catch (error) {
                this.logger.error("Failed to unpatch BetterDiscord patch.", error);
            }
        }
        this.unpatches.clear();
    }
}

function stringMatches(source: string, values: Array<string | RegExp>) {
    return values.every(value => {
        if (typeof value === "string") return source.includes(value);
        value.lastIndex = 0;
        return value.test(source);
    });
}

function moduleContainsCode(module: unknown, values: Array<string | RegExp>) {
    if (typeof module === "function") {
        return stringMatches(Function.prototype.toString.call(module), values);
    }

    if (!module || typeof module !== "object") return false;
    for (const value of Object.values(module)) {
        if (typeof value !== "function") continue;
        if (stringMatches(Function.prototype.toString.call(value), values)) return true;
    }
    return false;
}

function findInTree(tree: unknown, predicate: (value: unknown) => boolean, options?: BdFindInTreeOptions) {
    if (!tree) return null;

    const stack: unknown[] = [tree];
    const seen = new Set<unknown>();
    const walkable = options?.walkable;

    while (stack.length) {
        const value = stack.pop();
        if (!value || (typeof value !== "object" && typeof value !== "function") || seen.has(value)) continue;
        seen.add(value);

        if (predicate(value)) return value;

        if (Array.isArray(value)) {
            for (const item of value) stack.push(item);
            continue;
        }

        const keys = walkable ?? Object.keys(value);
        for (const key of keys) {
            if (!Object.hasOwn(value, key)) continue;
            stack.push((value as Record<string, unknown>)[key]);
        }
    }

    return null;
}

function toToastType(type: unknown) {
    if (typeof type !== "string") return Toasts.Type.MESSAGE;
    if (type === "success") return Toasts.Type.SUCCESS;
    if (type === "error" || type === "danger") return Toasts.Type.FAILURE;
    return Toasts.Type.MESSAGE;
}

class BdRuntime {
    private readonly patchers = new Set<CompatPatcher>();
    private readonly styles = new Set<BdApiStyleManager>();

    constructor(private readonly defaultPluginName: string) { }

    private getNativeFetchHelper(pluginName: string): NativeFetchHelper | null {
        if (!IS_DISCORD_DESKTOP) return null;

        const helpers = VencordNative?.pluginHelpers as Record<string, NativeFetchHelper> | undefined;
        const helper = helpers?.[pluginName];
        return typeof helper?.fetchFile === "function" ? helper : null;
    }

    private createWebpackApi() {
        const Filters = {
            byKeys: (...keys: string[]) => (module: unknown) =>
                !!module && typeof module === "object" && keys.every(key => (module as Record<string, unknown>)[key] !== undefined),
            bySource: (...code: Array<string | RegExp>) => (module: unknown) => moduleContainsCode(module, code),
            byStrings: (...code: Array<string | RegExp>) => (module: unknown) => moduleContainsCode(module, code),
        };

        const findModuleForBulkQuery = (query: BdBulkQuery) => {
            const matcher = query.filter;
            if (!matcher) return null;

            const found = find((module: unknown) => {
                if (matcher(module)) return true;

                if (query.searchDefault !== false && module && typeof module === "object" && "default" in module) {
                    return matcher((module as { default: unknown; }).default);
                }
                return false;
            }, { isIndirect: true, topLevelOnly: true });

            if (!found) return null;
            if (query.defaultExport === false) return found;

            if (query.searchDefault !== false && found && typeof found === "object" && "default" in found) {
                return (found as { default: unknown; }).default;
            }

            return found;
        };

        const scoreWebpackValue = (value: unknown) => {
            if (typeof value === "string") return 4;
            if (typeof value === "number" || typeof value === "boolean") return 2;
            if (typeof value === "function") return -3;
            if (value && typeof value === "object") return 1;
            if (value === null) return 0;
            return -4;
        };

        const scoreWebpackMatch = (module: Record<string, unknown> | null, keys: string[]) => {
            if (!module) return Number.NEGATIVE_INFINITY;
            return keys.reduce((score, key) =>
                score + (module[key] === undefined ? -8 : scoreWebpackValue(module[key]))
            , 0);
        };

        const findAllModulesByKeys = (keys: string[]) => {
            const directFilter = Filters.byKeys(...keys);
            const rawMatches = findAll((module: unknown) => {
                if (directFilter(module)) return true;
                if (!module || typeof module !== "object" || !("default" in module)) return false;
                return directFilter((module as { default: unknown; }).default);
            }, { topLevelOnly: true });

            const candidates: Array<Record<string, unknown>> = [];
            for (const rawMatch of rawMatches) {
                if (!rawMatch || typeof rawMatch !== "object") continue;
                const match = rawMatch as Record<string, unknown>;

                if (directFilter(match)) {
                    candidates.push(match);
                }

                const defaultExport = match.default;
                if (defaultExport && typeof defaultExport === "object" && directFilter(defaultExport)) {
                    candidates.push(defaultExport as Record<string, unknown>);
                }
            }

            return candidates;
        };

        const findBestModuleByKeys = (keys: string[]) => {
            const matches = findAllModulesByKeys(keys);
            if (!matches.length) return null;

            let best = matches[0];
            let bestScore = scoreWebpackMatch(best, keys);

            for (let i = 1; i < matches.length; i++) {
                const candidate = matches[i];
                const score = scoreWebpackMatch(candidate, keys);
                if (score <= bestScore) continue;
                best = candidate;
                bestScore = score;
            }

            return best;
        };

        const normalizeWebpackMatch = (match: Record<string, unknown> | null, keys: string[]) => {
            if (!match) return null;

            let normalized: Record<string, unknown> | null = null;
            const ensureNormalized = () => normalized ??= { ...match };

            const getStringFromValue = (value: unknown, key: string) => {
                if (typeof value === "string" && value.length) return value;
                if (typeof value !== "function") return null;

                const attempts = [
                    () => value(key),
                    () => value(),
                    () => value.call(match, key),
                    () => value.call(match)
                ];

                for (const attempt of attempts) {
                    try {
                        const resolved = attempt();
                        if (typeof resolved === "string" && resolved.length) return resolved;
                    } catch {
                        // noop
                    }
                }

                return null;
            };

            const resolveFallbackClassName = (key: string) => {
                const fallbackGetters = [
                    match.get,
                    (match.default as Record<string, unknown> | undefined)?.get
                ];

                for (const getter of fallbackGetters) {
                    if (typeof getter !== "function") continue;

                    try {
                        const resolved = getter.call(match, key);
                        if (typeof resolved === "string" && resolved.length) return resolved;
                    } catch {
                        // noop
                    }
                }

                try {
                    const cssMap = findCssClasses(key);
                    const mapped = cssMap?.[key as keyof typeof cssMap];
                    if (typeof mapped === "string" && mapped.length) return mapped;
                } catch {
                    // noop
                }

                return null;
            };

            for (const key of keys) {
                const base = normalized ?? match;
                const currentValue = base[key];
                if (typeof currentValue === "string" && currentValue.length) continue;

                const lookupKeys = [key, ...(legacyWebpackKeyAliases[key] ?? [])];
                let resolvedValue: string | null = null;

                for (const lookupKey of lookupKeys) {
                    resolvedValue = getStringFromValue(base[lookupKey], lookupKey)
                        ?? resolveFallbackClassName(lookupKey);
                    if (resolvedValue) break;
                }

                if (!resolvedValue) continue;
                ensureNormalized()[key] = resolvedValue;
            }

            return normalized ?? match;
        };

        const getByKeys = (...keys: string[]) => {
            if (!keys.length) return null;

            const strictMatch = findBestModuleByKeys(keys);
            const strictScore = scoreWebpackMatch(strictMatch, keys);

            const merged = {} as Record<string, unknown>;
            let hasAllKeys = true;

            for (const key of keys) {
                const aliases = legacyWebpackKeyAliases[key] ?? [];
                const lookupKeys = [key, ...aliases];

                let bestPartial = null as Record<string, unknown> | null;
                let bestLookupKey = key;
                let bestValueScore = Number.NEGATIVE_INFINITY;

                for (const lookupKey of lookupKeys) {
                    const match = findBestModuleByKeys([lookupKey]);
                    if (!match) continue;

                    const value = (match as Record<string, unknown>)[lookupKey];
                    const valueScore = scoreWebpackValue(value);
                    if (valueScore <= bestValueScore) continue;

                    bestPartial = match;
                    bestLookupKey = lookupKey;
                    bestValueScore = valueScore;
                }

                if (!bestPartial) {
                    hasAllKeys = false;
                    break;
                }

                Object.assign(merged, bestPartial);

                if (merged[key] === undefined) {
                    merged[key] = bestPartial[bestLookupKey];
                }
            }

            if (!hasAllKeys) {
                return normalizeWebpackMatch(strictMatch, keys);
            }

            const mergedScore = scoreWebpackMatch(merged, keys);
            const selectedMatch = mergedScore > strictScore ? merged : strictMatch;
            return normalizeWebpackMatch(selectedMatch, keys);
        };

        return {
            Filters,
            Stores: Object.freeze({ ...WebpackCommon }),
            getByKeys,
            getStore: (name: string) => findStore(name),
            getBulk: (...queries: BdBulkQuery[]) => queries.map(findModuleForBulkQuery)
        };
    }

    createBdApi(instanceName?: string) {
        const pluginName = instanceName ?? this.defaultPluginName;
        const logger = new Logger(`${pluginName}Compat`);
        const patcher = new CompatPatcher(logger);
        const styles = new CompatStyleManager(pluginName);
        const nativeFetchHelper = this.getNativeFetchHelper(pluginName);

        this.patchers.add(patcher);
        this.styles.add(styles);

        const webpackApi = this.createWebpackApi();

        const sharedApi = {
            Webpack: webpackApi,
            React,
            Hooks: { useStateFromStores },
            Utils: { findInTree },
            Patcher: {
                after: (...args: unknown[]) => patcher.after(...args),
                before: (...args: unknown[]) => patcher.before(...args),
                instead: (...args: unknown[]) => patcher.instead(...args),
                unpatchAll: () => patcher.unpatchAll()
            },
            DOM: {
                addStyle: (id: string, css: string) => styles.addStyle(id, css),
                removeStyle: (id: string) => styles.removeStyle(id)
            },
            Net: {
                fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
                    try {
                        return await fetch(input, init);
                    } catch (error) {
                        if (!nativeFetchHelper?.fetchFile) throw error;

                        const url = typeof input === "string"
                            ? input
                            : input instanceof URL
                                ? input.toString()
                                : input.url;

                        if (!/^https?:\/\//i.test(url)) throw error;

                        try {
                            const nativeResponse = await nativeFetchHelper.fetchFile(url, toSerializableRequestInit(init));

                            return new Response(nativeResponse.data, {
                                headers: nativeResponse.headers,
                                status: nativeResponse.status,
                                statusText: nativeResponse.statusText
                            });
                        } catch (nativeFetchError) {
                            logger.error("Failed native fetch fallback.", nativeFetchError);
                            throw error;
                        }
                    }
                }
            },
            UI: {
                showToast: (message: string, options?: { type?: string; timeout?: number; }) => showToast(message, toToastType(options?.type), options?.timeout ? { duration: options.timeout } : undefined),
                showConfirmationModal: (title: string, content: React.ReactNode, options?: {
                    confirmText?: string;
                    cancelText?: string;
                    onConfirm?: () => void;
                    onCancel?: () => void;
                }) => Alerts.show({
                    title,
                    body: content,
                    confirmText: options?.confirmText ?? "Confirm",
                    cancelText: options?.cancelText ?? "Cancel",
                    onConfirm: options?.onConfirm,
                    onCancel: options?.onCancel
                }),
                alert: (title: string, content: React.ReactNode) => Alerts.show({
                    title,
                    body: content,
                    confirmText: "OK"
                })
            },
            Plugins: { folder: "" },
            Logger: {
                log: (...args: unknown[]) => logger.log(...args),
                warn: (...args: unknown[]) => logger.warn(...args),
                error: (...args: unknown[]) => logger.error(...args),
            }
        };

        const runtime = this;
        const BdApiCtor = function (name?: string) {
            return runtime.createBdApi(name);
        } as unknown as Record<string, unknown>;

        Object.assign(BdApiCtor, sharedApi);
        return BdApiCtor;
    }

    dispose() {
        for (const patcher of this.patchers) patcher.unpatchAll();
        for (const styleManager of this.styles) styleManager.clear();
        this.patchers.clear();
        this.styles.clear();
    }
}

function loadLegacyPlugin(source: string, bdApi: unknown, pluginName: string, logger: Logger) {
    const module = { exports: {} as unknown };
    const localStorage = resolveLocalStorage();
    const globalScope = typeof globalThis === "undefined" ? {} : globalThis;
    const windowScope = typeof window === "undefined" ? globalScope : window;
    const requireShim = createLegacyRequireShim(pluginName, logger);
    const pluginFactory = new Function("module", "exports", "BdApi", "window", "globalThis", "global", "localStorage", "require", source);
    pluginFactory(module, module.exports, bdApi, windowScope, globalScope, globalScope, localStorage, requireShim);
    const exported = module.exports as { default?: unknown; };
    return exported.default ?? exported;
}

export function createBdPluginBridge(pluginName: string, source: string) {
    const logger = new Logger(pluginName);
    let runtime: BdRuntime | null = null;
    let legacyInstance: { start?: () => void; stop?: () => void; } | null = null;

    const stop = () => {
        try {
            legacyInstance?.stop?.();
        } catch (error) {
            logger.error("Failed to stop legacy BetterDiscord plugin.", error);
        }

        runtime?.dispose();
        runtime = null;
        legacyInstance = null;
    };

    const start = () => {
        stop();
        runtime = new BdRuntime(pluginName);
        const bdApi = runtime.createBdApi(pluginName);

        let LegacyPluginCtor: unknown;
        try {
            LegacyPluginCtor = loadLegacyPlugin(source, bdApi, pluginName, logger);
        } catch (error) {
            logger.error("Failed to evaluate legacy BetterDiscord plugin.", error);
            stop();
            return;
        }

        if (typeof LegacyPluginCtor !== "function") {
            logger.error("Legacy BetterDiscord plugin did not export a constructor.");
            stop();
            return;
        }

        try {
            legacyInstance = new (LegacyPluginCtor as new (...args: unknown[]) => { start?: () => void; stop?: () => void; })({ name: pluginName });
            legacyInstance.start?.();
        } catch (error) {
            logger.error("Failed to start legacy BetterDiscord plugin.", error);
            stop();
        }
    };

    return { start, stop };
}
