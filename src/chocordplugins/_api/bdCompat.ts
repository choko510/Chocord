/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { registerCommand, unregisterCommand } from "@api/Commands";
import { addContextMenuPatch, removeContextMenuPatch } from "@api/ContextMenu";
import { managedStyleRootNode } from "@api/Styles";
import { createAndAppendStyle } from "@utils/css";
import { Logger } from "@utils/Logger";
import { findAll, findCssClasses, findStore, mapMangledModule, wreq } from "@webpack";
import * as WebpackCommon from "@webpack/common";
import { Alerts, ContextMenuApi, Menu, React, showToast, Toasts, useStateFromStores } from "@webpack/common";

type BdFilter = (module: unknown) => boolean;

interface BdWebpackSearchOptions {
    defaultExport?: boolean;
    searchDefault?: boolean;
    searchExports?: boolean;
}

interface BdBulkQuery extends BdWebpackSearchOptions {
    filter?: BdFilter;
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

interface BdMenuItem {
    type?: string;
    label?: React.ReactNode;
    action?: () => void;
    checked?: boolean | (() => boolean);
    disabled?: boolean;
    items?: BdMenuItem[];
}

interface BdChangelogEntry {
    title?: string;
    type?: string;
    items?: unknown[];
}

interface BdChangelogModalOptions {
    title?: string;
    subtitle?: string;
    blurb?: string;
    changes?: BdChangelogEntry[];
}

interface BdNoticeOptions {
    type?: string;
    timeout?: number;
}

interface BdMatcherMeta {
    keys?: readonly string[];
    storeName?: string;
}

// Legacy BD plugins often destructure stores at module-eval time; keep lookups live instead of snapshotting.
const compatStores = new Proxy(WebpackCommon as Record<string, unknown>, {
    get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (value !== undefined || typeof prop !== "string" || !prop.endsWith("Store")) {
            return value;
        }

        return findStore(prop);
    }
});
const legacyWebpackKeyAliases: Readonly<Record<string, readonly string[]>> = Object.freeze({
    threadMessageAccessoryContentLeadingIcon: ["messageContent"]
});
const BD_COMPAT_MAX_CACHE_ENTRIES = 256;
const BD_COMPAT_MAX_FACTORY_CACHE_ENTRIES = 16;
const BD_COMPAT_CACHE_KEY_SEPARATOR = "\u0000";
const BD_COMPAT_DATA_STORAGE_PREFIX = "bdCompat:data:";
const BD_COMPAT_PROXY_PROBE_KEY = "is this a proxy that returns values for any key?";
const BD_COMPAT_FALLBACK_CLASS_NAME = "bd-compat-empty";
const BD_COMPAT_MATCHER_META = Symbol("bdCompatMatcherMeta");
const functionSourceCache = new WeakMap<Function, string>();
const legacyPluginFactoryCache = new Map<string, Function>();
const BD_COMMAND_OPTION_TYPES = Object.freeze({
    SUB_COMMAND: 1,
    SUB_COMMAND_GROUP: 2,
    STRING: 3,
    INTEGER: 4,
    BOOLEAN: 5,
    USER: 6,
    CHANNEL: 7,
    ROLE: 8,
    MENTIONABLE: 9,
    NUMBER: 10,
    ATTACHMENT: 11
});

function getCacheKey(parts: readonly string[]) {
    return parts.join(BD_COMPAT_CACHE_KEY_SEPARATOR);
}

function setBoundedCacheEntry<T>(cache: Map<string, T>, key: string, value: T) {
    if (cache.size >= BD_COMPAT_MAX_CACHE_ENTRIES) {
        cache.clear();
    }

    cache.set(key, value);
    return value;
}

function getFunctionSource(value: Function) {
    let source = functionSourceCache.get(value);
    if (source === undefined) {
        source = Function.prototype.toString.call(value);
        functionSourceCache.set(value, source);
    }

    return source;
}

function getLegacyPluginFactory(source: string) {
    let pluginFactory = legacyPluginFactoryCache.get(source);
    if (pluginFactory) {
        return pluginFactory;
    }

    if (legacyPluginFactoryCache.size >= BD_COMPAT_MAX_FACTORY_CACHE_ENTRIES) {
        legacyPluginFactoryCache.clear();
    }

    pluginFactory = new Function("module", "exports", "BdApi", "window", "globalThis", "global", "localStorage", "require", source);
    legacyPluginFactoryCache.set(source, pluginFactory);
    return pluginFactory;
}

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
            if (!Number.isInteger(index) || index < 0) return null;

            let currentIndex = 0;
            for (const key of values.keys()) {
                if (currentIndex === index) {
                    return key;
                }
                currentIndex++;
            }

            return null;
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

function getLegacyGlobalScopes(...candidates: unknown[]) {
    const scopes = [] as Record<string, unknown>[];

    for (const candidate of candidates) {
        if (!candidate || (typeof candidate !== "object" && typeof candidate !== "function")) continue;

        const scope = candidate as Record<string, unknown>;
        if (scopes.includes(scope)) continue;
        scopes.push(scope);
    }

    return scopes;
}

function bindLegacyBdApi(bdApi: unknown, scopes: ReadonlyArray<Record<string, unknown>>) {
    const boundScopes = [] as Array<{
        scope: Record<string, unknown>;
        hadOwn: boolean;
        previousValue: unknown;
    }>;

    for (const scope of scopes) {
        const hadOwn = Object.prototype.hasOwnProperty.call(scope, "BdApi");
        const previousValue = scope.BdApi;
        const didSet = Reflect.set(scope, "BdApi", bdApi);
        if (!didSet) continue;

        boundScopes.push({
            scope,
            hadOwn,
            previousValue
        });
    }

    return () => {
        for (const { scope, hadOwn, previousValue } of boundScopes.reverse()) {
            if (hadOwn) {
                Reflect.set(scope, "BdApi", previousValue);
            } else {
                Reflect.deleteProperty(scope, "BdApi");
            }
        }
    };
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
        return stringMatches(getFunctionSource(module), values);
    }

    if (!module || typeof module !== "object") return false;
    for (const value of Object.values(module)) {
        if (typeof value !== "function") continue;
        if (stringMatches(getFunctionSource(value), values)) return true;
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

        if (walkable) {
            for (const key of walkable) {
                if (!Object.hasOwn(value, key)) continue;
                stack.push((value as Record<string, unknown>)[key]);
            }
            continue;
        }

        for (const key of Object.keys(value)) {
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
    private readonly logger = new Logger("BdCompatRuntime");
    private readonly patchers = new Set<CompatPatcher>();
    private readonly styles = new Set<BdApiStyleManager>();
    private readonly apiInstances = new Map<string, Record<string, unknown>>();
    private readonly cleanups = new Set<() => void>();
    private readonly webpackApi = this.createWebpackApi();

    constructor(private readonly defaultPluginName: string) { }

    private getNativeFetchHelper(pluginName: string): NativeFetchHelper | null {
        if (!IS_DISCORD_DESKTOP) return null;

        const helpers = VencordNative?.pluginHelpers as Record<string, NativeFetchHelper> | undefined;
        const helper = helpers?.[pluginName];
        return typeof helper?.fetchFile === "function" ? helper : null;
    }

    private createWebpackApi() {
        const runtimeLogger = this.logger;
        const withMatcherMeta = (matcher: BdFilter, meta: BdMatcherMeta) => {
            try {
                Object.defineProperty(matcher, BD_COMPAT_MATCHER_META, {
                    value: meta,
                    configurable: true
                });
            } catch {
                // noop
            }

            return matcher;
        };
        const getMatcherMeta = (matcher: BdFilter): BdMatcherMeta | null => {
            const meta = (matcher as BdFilter & { [BD_COMPAT_MATCHER_META]?: BdMatcherMeta; })[BD_COMPAT_MATCHER_META];
            return meta ?? null;
        };
        const Filters = {
            byKeys: (...keys: string[]) => withMatcherMeta(
                (module: unknown) =>
                    !!module && typeof module === "object" && keys.every(key => (module as Record<string, unknown>)[key] !== undefined),
                { keys }
            ),
            byStoreName: (name: string) => withMatcherMeta((module: unknown) => {
                if (!module || (typeof module !== "object" && typeof module !== "function")) return false;
                const store = module as {
                    constructor?: { displayName?: string; };
                    getName?: () => string;
                };
                if (store.constructor?.displayName === name) return true;

                try {
                    return typeof store.getName === "function" && store.getName() === name;
                } catch {
                    return false;
                }
            }, { storeName: name }),
            byComponentType: (matcher: BdFilter) => withMatcherMeta((module: unknown) => {
                if (typeof matcher !== "function") return false;

                const seen = new Set<unknown>();
                let component = module;
                while (component != null && !seen.has(component)) {
                    seen.add(component);

                    try {
                        if (matcher(component)) {
                            return true;
                        }
                    } catch {
                        // noop
                    }

                    if (typeof component !== "object" && typeof component !== "function") return false;

                    const typedComponent = component as { type?: unknown; render?: unknown; };
                    if (typedComponent.type) {
                        component = typedComponent.type;
                        continue;
                    }

                    if (typedComponent.render) {
                        component = typedComponent.render;
                        continue;
                    }

                    return false;
                }

                return false;
            }, getMatcherMeta(matcher) ?? {}),
            bySource: (...code: Array<string | RegExp>) => (module: unknown) => moduleContainsCode(module, code),
            byStrings: (...code: Array<string | RegExp>) => (module: unknown) => moduleContainsCode(module, code),
        };
        const modulesByKeysCache = new Map<string, Array<Record<string, unknown>>>();
        const bestModuleByKeysCache = new Map<string, Record<string, unknown> | null>();
        const normalizedModuleCache = new WeakMap<Record<string, unknown>, Map<string, Record<string, unknown>>>();

        const isWebpackSearchOptions = (value: unknown): value is BdWebpackSearchOptions => {
            if (!value || typeof value !== "object" || Array.isArray(value) || value instanceof RegExp) {
                return false;
            }

            return "defaultExport" in value || "searchDefault" in value || "searchExports" in value;
        };

        const webpackMatcherPropertyKeysCache = new WeakMap<BdFilter, string[]>();
        const webpackStoreNameMatcherCache = new WeakMap<BdFilter, string | null>();
        const ignoredWebpackMatcherKeys = new Set([
            "call",
            "apply",
            "bind",
            "constructor",
            "default",
            "hasOwnProperty",
            "includes",
            "length",
            "name",
            "prototype",
            "toString",
            "valueOf"
        ]);
        const isWebpackCodeMatch = (value: unknown): value is string | RegExp =>
            typeof value === "string" || value instanceof RegExp;
        const isProxyGetterFunction = (value: unknown) => {
            if (typeof value !== "function") return false;
            const source = getFunctionSource(value);

            return source.includes(".get(t,n)")
                || source.includes("=>e.get(")
                || source.includes("=>t.get(")
                || source.includes("=>n.get(");
        };

        const isLikelyAnyKeyProxy = (value: unknown) => {
            if (!value || (typeof value !== "object" && typeof value !== "function")) return false;

            const target = value as Record<string, unknown>;
            try {
                const probeResult = target[BD_COMPAT_PROXY_PROBE_KEY];
                if (probeResult === undefined) {
                    return false;
                }

                Reflect.deleteProperty(target, BD_COMPAT_PROXY_PROBE_KEY);
                return true;
            } catch {
                return false;
            }
        };

        const getWebpackMatcherPropertyKeys = (matcher: BdFilter) => {
            const cachedKeys = webpackMatcherPropertyKeysCache.get(matcher);
            if (cachedKeys) {
                return cachedKeys;
            }

            const matcherMeta = getMatcherMeta(matcher);
            if (Array.isArray(matcherMeta?.keys) && matcherMeta.keys.length) {
                const normalizedKeys = [...new Set(
                    matcherMeta.keys.filter((key): key is string => typeof key === "string" && key.length > 0)
                )];
                webpackMatcherPropertyKeysCache.set(matcher, normalizedKeys);
                return normalizedKeys;
            }

            const extractedKeys = new Set<string>();
            const matcherSource = getFunctionSource(matcher);
            const dotAccessMatcher = /\.\s*([A-Za-z_$][\w$]*)/g;

            let nextMatch = dotAccessMatcher.exec(matcherSource);
            while (nextMatch) {
                const key = nextMatch[1];
                if (key && !ignoredWebpackMatcherKeys.has(key)) {
                    extractedKeys.add(key);
                }

                nextMatch = dotAccessMatcher.exec(matcherSource);
            }

            const propertyKeys = [...extractedKeys];
            webpackMatcherPropertyKeysCache.set(matcher, propertyKeys);
            return propertyKeys;
        };

        const getStoreNameFromMatcher = (matcher: BdFilter) => {
            const cachedStoreName = webpackStoreNameMatcherCache.get(matcher);
            if (cachedStoreName !== undefined) {
                return cachedStoreName;
            }

            const matcherMeta = getMatcherMeta(matcher);
            if (typeof matcherMeta?.storeName === "string" && matcherMeta.storeName.length > 0) {
                webpackStoreNameMatcherCache.set(matcher, matcherMeta.storeName);
                return matcherMeta.storeName;
            }

            const matcherSource = getFunctionSource(matcher);
            const parsedStoreName = matcherSource.match(/getName\??\.\(\)\s*===\s*["'`]([^"'`]+)["'`]/)?.[1]
                ?? matcherSource.match(/constructor\??\.displayName\s*===\s*["'`]([^"'`]+)["'`]/)?.[1]
                ?? null;

            webpackStoreNameMatcherCache.set(matcher, parsedStoreName);
            return parsedStoreName;
        };

        const getWebpackSearchCandidates = (module: unknown, options: BdWebpackSearchOptions) => {
            const candidates: unknown[] = [];
            const seenCandidates = new Set<unknown>();
            const addCandidate = (candidate: unknown) => {
                if (!candidate || (typeof candidate !== "object" && typeof candidate !== "function")) return;
                if (isLikelyAnyKeyProxy(candidate)) return;
                if (seenCandidates.has(candidate)) return;
                seenCandidates.add(candidate);
                candidates.push(candidate);
            };

            const moduleRecord = module && typeof module === "object"
                ? module as Record<string, unknown>
                : null;

            if (options.searchExports && moduleRecord) {
                Object.values(moduleRecord).forEach(addCandidate);

                if (options.searchDefault !== false) {
                    const defaultExport = moduleRecord.default;
                    if (defaultExport && typeof defaultExport === "object") {
                        Object.values(defaultExport as Record<string, unknown>).forEach(addCandidate);
                    }
                }
            }

            addCandidate(module);

            if (options.searchDefault !== false && moduleRecord && "default" in moduleRecord) {
                addCandidate(moduleRecord.default);
            }

            return candidates;
        };

        const findWebpackMatch = (
            module: unknown,
            matcher: BdFilter,
            options: BdWebpackSearchOptions
        ): { match: unknown; module: unknown; } | null => {
            for (const candidate of getWebpackSearchCandidates(module, options)) {
                try {
                    if (!matcher(candidate)) continue;
                    return { match: candidate, module };
                } catch {
                    // noop
                }
            }

            return null;
        };

        const scoreWebpackFilterValue = (value: unknown) => {
            if (value === undefined) return -12;
            if (value === null) return -5;
            if (typeof value === "function") return isProxyGetterFunction(value) ? -25 : 6;
            if (Array.isArray(value)) return 10;
            if (value && typeof value === "object") return 8;
            if (typeof value === "string") return value.length ? 10 : 0;
            if (typeof value === "number" || typeof value === "boolean") return 3;
            return 1;
        };

        const scoreWebpackFilterMatch = (
            resolvedMatch: { match: unknown; module: unknown; },
            propertyKeys: readonly string[]
        ) => {
            const scoreTarget = (resolvedMatch.match && (typeof resolvedMatch.match === "object" || typeof resolvedMatch.match === "function"))
                ? resolvedMatch.match as Record<string, unknown>
                : null;

            let score = 0;
            for (const key of propertyKeys) {
                const value = scoreTarget?.[key];
                score += scoreWebpackFilterValue(value);

                // Handle common highlight.js probe used by legacy plugins.
                if (key === "listLanguages" && typeof value === "function") {
                    try {
                        score += Array.isArray(value.call(resolvedMatch.match)) ? 80 : -25;
                    } catch {
                        score -= 12;
                    }
                }
            }

            if (
                resolvedMatch.module &&
                typeof resolvedMatch.module === "object" &&
                "default" in resolvedMatch.module &&
                (resolvedMatch.module as { default?: unknown; }).default === resolvedMatch.match
            ) {
                score += 10;
            }

            return score;
        };

        const hasProxyGetterAtKeys = (candidate: unknown, keys: readonly string[]) => {
            if (!candidate || (typeof candidate !== "object" && typeof candidate !== "function")) return false;

            const candidateRecord = candidate as Record<string, unknown>;
            return keys.some(key => isProxyGetterFunction(candidateRecord[key]));
        };

        const resolveKnownMatcherFallback = (keys: readonly string[]) => {
            if (!keys.length) return null;

            const keySet = new Set(keys);
            if (keySet.has("scrollerInner")) {
                return Object.fromEntries(
                    keys.map(key => [key, BD_COMPAT_FALLBACK_CLASS_NAME])
                );
            }

            if (keySet.has("defaultProps") && keySet.has("renderEmbeds")) {
                return {
                    defaultProps: {
                        renderEmbeds: () => null
                    },
                    prototype: {
                        renderAttachments: () => null
                    }
                };
            }

            if (keySet.has("thin") && keySet.has("none")) {
                return {
                    thin: BD_COMPAT_FALLBACK_CLASS_NAME,
                    none: BD_COMPAT_FALLBACK_CLASS_NAME
                };
            }

            if (keySet.has("languageSelector") && keySet.has("fileName")) {
                return {
                    languageSelector: BD_COMPAT_FALLBACK_CLASS_NAME,
                    fileName: BD_COMPAT_FALLBACK_CLASS_NAME
                };
            }

            if (keySet.has("messageListItem")) {
                return { messageListItem: BD_COMPAT_FALLBACK_CLASS_NAME };
            }

            return null;
        };

        const findBestWebpackFilterMatch = (matcher: BdFilter, options: BdWebpackSearchOptions) => {
            const propertyKeys = getWebpackMatcherPropertyKeys(matcher);
            const matches = [] as Array<{ match: unknown; module: unknown; score: number; }>;
            const seenMatches = new Set<unknown>();

            const matchedModules = findAll(
                (module: unknown) => findWebpackMatch(module, matcher, options) !== null,
                { topLevelOnly: true }
            );

            for (const module of matchedModules) {
                const resolvedMatch = findWebpackMatch(module, matcher, options);
                if (!resolvedMatch) continue;

                const dedupeKey = resolvedMatch.match;
                if (seenMatches.has(dedupeKey)) continue;
                seenMatches.add(dedupeKey);

                matches.push({
                    ...resolvedMatch,
                    score: scoreWebpackFilterMatch(resolvedMatch, propertyKeys)
                });
            }

            if (!matches.length) return null;
            matches.sort((left, right) => right.score - left.score);

            const bestMatch = matches[0];
            if (propertyKeys.length > 0 && bestMatch.score < 0) {
                return null;
            }

            return bestMatch;
        };

        const getModule = (matcher: BdFilter, options: BdWebpackSearchOptions = {}) => {
            if (typeof matcher !== "function") return null;

            const resolvedOptions = {
                searchDefault: true,
                ...options
            };
            const propertyKeys = getWebpackMatcherPropertyKeys(matcher);

            const resolvedMatch = findBestWebpackFilterMatch(matcher, resolvedOptions)
                ?? (
                    resolvedOptions.searchExports
                        ? null
                        : findBestWebpackFilterMatch(matcher, {
                            ...resolvedOptions,
                            searchExports: true
                        })
                );
            if (!resolvedMatch) {
                if (propertyKeys.length > 0) {
                    const byKeysFallback = getByKeys(...propertyKeys);
                    if (byKeysFallback && !hasProxyGetterAtKeys(byKeysFallback, propertyKeys)) {
                        try {
                            if (matcher(byKeysFallback)) {
                                return byKeysFallback;
                            }
                        } catch {
                            // noop
                        }
                    }
                }

                const parsedStoreName = getStoreNameFromMatcher(matcher);
                if (!parsedStoreName) {
                    const knownFallback = resolveKnownMatcherFallback(propertyKeys);
                    if (knownFallback) {
                        runtimeLogger.warn(
                            `Using BetterDiscord compatibility fallback for unresolved matcher keys: ${propertyKeys.join(", ")}`
                        );
                        return knownFallback;
                    }

                    return null;
                }

                const fallbackStore = findStore(parsedStoreName);
                if (!fallbackStore) {
                    runtimeLogger.warn(`Failed to resolve BetterDiscord Webpack module for store "${parsedStoreName}".`);
                    return null;
                }

                return fallbackStore;
            }
            if (resolvedOptions.defaultExport === false) return resolvedMatch.module;

            if (
                !resolvedOptions.searchExports &&
                resolvedOptions.searchDefault !== false &&
                resolvedMatch.module &&
                typeof resolvedMatch.module === "object" &&
                "default" in resolvedMatch.module
            ) {
                const defaultExport = (resolvedMatch.module as { default?: unknown; }).default;
                if (defaultExport != null) {
                    if (defaultExport === resolvedMatch.match) {
                        return defaultExport;
                    }

                    try {
                        if (matcher(defaultExport)) {
                            return defaultExport;
                        }
                    } catch {
                        // noop
                    }

                    // Preserve BetterDiscord-like behavior for wrapped default exports.
                    const moduleExportKeys = Object.keys(resolvedMatch.module as Record<string, unknown>);
                    if (moduleExportKeys.length <= 2 && moduleExportKeys.includes("default")) {
                        return defaultExport;
                    }
                }

            }

            return resolvedMatch.match;
        };

        const getByStrings = (...parts: Array<string | RegExp | BdWebpackSearchOptions>) => {
            if (!parts.length) return null;

            const maybeOptions = parts[parts.length - 1];
            const options = isWebpackSearchOptions(maybeOptions) ? maybeOptions : undefined;
            const code = (options ? parts.slice(0, -1) : parts).filter(isWebpackCodeMatch);
            if (!code.length) return null;

            return getModule(Filters.byStrings(...code), options);
        };

        const getMangled = <T extends string>(
            code: string | RegExp | Array<string | RegExp>,
            mappers: Record<T, BdFilter>,
            includeBlacklistedExports = false
        ) => {
            if (!mappers || typeof mappers !== "object") return {} as Record<T, unknown>;

            return mapMangledModule(
                code,
                mappers as Record<T, (module: unknown) => boolean>,
                includeBlacklistedExports
            );
        };

        const findModuleForBulkQuery = (query: BdBulkQuery) => {
            const matcher = query.filter;
            if (!matcher) return null;
            return getModule(matcher, query);
        };

        const scoreWebpackValue = (value: unknown) => {
            if (typeof value === "string") return 6;
            if (typeof value === "number" || typeof value === "boolean") return 2;
            if (typeof value === "function") return isProxyGetterFunction(value) ? -30 : -1;
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
            const cacheKey = getCacheKey(keys);
            const cachedMatches = modulesByKeysCache.get(cacheKey);
            if (cachedMatches) {
                return cachedMatches;
            }

            const directFilter = Filters.byKeys(...keys);
            const rawMatches = findAll((module: unknown) => {
                if (directFilter(module)) return true;
                if (!module || typeof module !== "object" || !("default" in module)) return false;
                return directFilter((module as { default: unknown; }).default);
            }, { topLevelOnly: true });

            const candidates: Array<Record<string, unknown>> = [];
            const seenMatches = new Set<Record<string, unknown>>();
            for (const rawMatch of rawMatches) {
                if (!rawMatch || typeof rawMatch !== "object") continue;
                if (isLikelyAnyKeyProxy(rawMatch)) continue;
                const match = rawMatch as Record<string, unknown>;

                if (directFilter(match) && !seenMatches.has(match)) {
                    seenMatches.add(match);
                    candidates.push(match);
                }

                const defaultExport = match.default;
                if (
                    defaultExport &&
                    typeof defaultExport === "object" &&
                    directFilter(defaultExport) &&
                    !seenMatches.has(defaultExport as Record<string, unknown>)
                ) {
                    const directDefault = defaultExport as Record<string, unknown>;
                    if (isLikelyAnyKeyProxy(directDefault)) continue;
                    seenMatches.add(directDefault);
                    candidates.push(directDefault);
                }
            }

            return setBoundedCacheEntry(modulesByKeysCache, cacheKey, candidates);
        };

        const findBestModuleByKeys = (keys: string[]) => {
            const cacheKey = getCacheKey(keys);
            if (bestModuleByKeysCache.has(cacheKey)) {
                return bestModuleByKeysCache.get(cacheKey)!;
            }

            const matches = findAllModulesByKeys(keys);
            if (!matches.length) {
                return setBoundedCacheEntry(bestModuleByKeysCache, cacheKey, null);
            }

            let best = matches[0];
            let bestScore = scoreWebpackMatch(best, keys);

            for (let i = 1; i < matches.length; i++) {
                const candidate = matches[i];
                const score = scoreWebpackMatch(candidate, keys);
                if (score <= bestScore) continue;
                best = candidate;
                bestScore = score;
            }

            return setBoundedCacheEntry(bestModuleByKeysCache, cacheKey, best);
        };

        const normalizeWebpackMatch = (match: Record<string, unknown> | null, keys: string[]) => {
            if (!match) return null;

            const cacheKey = getCacheKey(keys);
            const cachedMatches = normalizedModuleCache.get(match);
            const cachedNormalized = cachedMatches?.get(cacheKey);
            if (cachedNormalized) {
                return cachedNormalized;
            }

            let normalized: Record<string, unknown> | null = null;
            const ensureNormalized = () => normalized ??= { ...match };

            const getStringFromValue = (value: unknown, _key: string) => {
                if (typeof value === "string" && value.length) return value;

                return null;
            };

            const resolveFallbackClassName = (key: string, sourceValue: unknown) => {
                if (typeof sourceValue === "function") return null;

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
                    const lookupValue = base[lookupKey];
                    resolvedValue = getStringFromValue(lookupValue, lookupKey)
                        ?? resolveFallbackClassName(lookupKey, lookupValue);
                    if (resolvedValue) break;
                }

                if (!resolvedValue) continue;
                ensureNormalized()[key] = resolvedValue;
            }

            const normalizedMatch = normalized ?? match;
            const normalizedMatches = cachedMatches ?? new Map<string, Record<string, unknown>>();
            if (normalizedMatches.size >= BD_COMPAT_MAX_CACHE_ENTRIES) {
                normalizedMatches.clear();
            }
            normalizedMatches.set(cacheKey, normalizedMatch);

            if (!cachedMatches) {
                normalizedModuleCache.set(match, normalizedMatches);
            }

            return normalizedMatch;
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

        const getById = (id: string | number) => {
            const targetId = typeof id === "number" || typeof id === "string"
                ? id
                : String(id ?? "");
            if (targetId === "") return null;

            try {
                return wreq(targetId as PropertyKey);
            } catch {
                // noop
            }

            if (typeof targetId === "string") {
                const numericId = Number(targetId);
                if (Number.isNaN(numericId)) return null;

                try {
                    return wreq(numericId as PropertyKey);
                } catch {
                    // noop
                }
            }

            return null;
        };

        return {
            Filters,
            Stores: compatStores,
            getByKeys,
            getById,
            getByStrings,
            getStore: (name: string) => findStore(name),
            getModule,
            getMangled,
            getBulk: (...queries: BdBulkQuery[]) => queries.map(findModuleForBulkQuery)
        };
    }

    createBdApi(instanceName?: string) {
        const pluginName = instanceName ?? this.defaultPluginName;
        const cachedApi = this.apiInstances.get(pluginName);
        if (cachedApi) {
            return cachedApi;
        }

        const logger = new Logger(`${pluginName}Compat`);
        const patcher = new CompatPatcher(logger);
        const styles = new CompatStyleManager(pluginName);
        const nativeFetchHelper = this.getNativeFetchHelper(pluginName);

        this.patchers.add(patcher);
        this.styles.add(styles);

        const { webpackApi } = this;
        const registeredCommands = new Set<string>();

        const toDataNamespace = (value: unknown) => {
            if (typeof value === "string" && value.length) return value;
            if (value === null || value === undefined) return pluginName;
            return String(value);
        };

        const toDataKey = (value: unknown) => String(value);
        const toDataStorageKey = (namespace: string, key: string) =>
            `${BD_COMPAT_DATA_STORAGE_PREFIX}${encodeURIComponent(namespace)}:${encodeURIComponent(key)}`;

        const resolveDataLoadArgs = (args: unknown[]) => {
            if (args.length === 1) {
                return {
                    namespace: pluginName,
                    key: toDataKey(args[0])
                };
            }

            if (args.length >= 2) {
                return {
                    namespace: toDataNamespace(args[0]),
                    key: toDataKey(args[1])
                };
            }

            logger.warn("BdApi.Data.load called without a key.");
            return null;
        };

        const resolveDataSaveArgs = (args: unknown[]) => {
            if (args.length === 2) {
                return {
                    namespace: pluginName,
                    key: toDataKey(args[0]),
                    value: args[1]
                };
            }

            if (args.length >= 3) {
                return {
                    namespace: toDataNamespace(args[0]),
                    key: toDataKey(args[1]),
                    value: args[2]
                };
            }

            logger.warn("BdApi.Data.save called without key/value.");
            return null;
        };

        const dataApi = {
            load: (...args: unknown[]) => {
                const resolved = resolveDataLoadArgs(args);
                if (!resolved) return undefined;

                const storage = resolveLocalStorage();
                const storageKey = toDataStorageKey(resolved.namespace, resolved.key);
                const stored = storage.getItem(storageKey);
                if (stored == null) return undefined;

                try {
                    return JSON.parse(stored);
                } catch {
                    return stored;
                }
            },
            save: (...args: unknown[]) => {
                const resolved = resolveDataSaveArgs(args);
                if (!resolved) return undefined;

                const storage = resolveLocalStorage();
                const storageKey = toDataStorageKey(resolved.namespace, resolved.key);

                try {
                    const serialized = JSON.stringify(resolved.value);
                    if (serialized === undefined) {
                        storage.removeItem(storageKey);
                    } else {
                        storage.setItem(storageKey, serialized);
                    }
                } catch (error) {
                    logger.error("Failed to persist BdApi.Data.save payload.", error);
                    throw error;
                }

                return resolved.value;
            },
            delete: (...args: unknown[]) => {
                const resolved = resolveDataLoadArgs(args);
                if (!resolved) return false;

                const storage = resolveLocalStorage();
                const storageKey = toDataStorageKey(resolved.namespace, resolved.key);
                storage.removeItem(storageKey);
                return true;
            }
        };

        const unregisterAllCompatCommands = () => {
            for (const commandName of [...registeredCommands]) {
                unregisterCommand(commandName);
                registeredCommands.delete(commandName);
            }
        };

        const commandApi = {
            Types: {
                OptionTypes: BD_COMMAND_OPTION_TYPES
            },
            register: (command: unknown) => {
                if (!command || typeof command !== "object") {
                    logger.warn("BdApi.Commands.register called with invalid command.");
                    return;
                }

                const commandName = (command as { name?: unknown; }).name;
                if (typeof commandName !== "string" || !commandName.length) {
                    logger.warn("BdApi.Commands.register called without a command name.");
                    return;
                }

                registerCommand(command as never, pluginName);
                registeredCommands.add(commandName);
            },
            unregister: (name: unknown) => {
                const commandName = typeof name === "string" ? name : String(name ?? "");
                if (!commandName) return false;
                registeredCommands.delete(commandName);
                return unregisterCommand(commandName);
            },
            unregisterAll: () => unregisterAllCompatCommands()
        };
        this.cleanups.add(unregisterAllCompatCommands);

        const toNoticeText = (content: unknown) => {
            if (typeof content === "string") return content;
            if (typeof content === "number" || typeof content === "boolean") return String(content);

            if (typeof Node !== "undefined" && content instanceof Node) {
                return content.textContent ?? "";
            }

            return `${pluginName} notice`;
        };
        const defaultLegacyStyleId = `${pluginName}:style`;

        const renderFallbackMenuItems = (items: BdMenuItem[], onClose?: () => void, prefix = "menu") => {
            const renderEntries: React.ReactNode[] = [];

            for (let index = 0; index < items.length; index++) {
                const item = items[index];
                const key = `${prefix}-${index}`;
                if (!item || typeof item !== "object") continue;

                if (item.type === "separator") {
                    renderEntries.push(React.createElement("hr", { key }));
                    continue;
                }

                const nestedItems = Array.isArray(item.items) ? item.items : [];
                if (item.type === "group") {
                    renderEntries.push(...renderFallbackMenuItems(nestedItems, onClose, `${key}-group`));
                    continue;
                }

                if (item.type === "submenu") {
                    renderEntries.push(
                        React.createElement(
                            "div",
                            { key, style: { padding: "4px 0" } },
                            React.createElement("div", { style: { fontWeight: 600, marginBottom: 4 } }, item.label ?? "Submenu"),
                            ...renderFallbackMenuItems(nestedItems, onClose, `${key}-submenu`)
                        )
                    );
                    continue;
                }

                let checked = false;
                if (typeof item.checked === "function") {
                    try {
                        checked = Boolean(item.checked());
                    } catch (error) {
                        logger.error("Failed to evaluate BdApi.ContextMenu toggle state.", error);
                    }
                } else {
                    checked = Boolean(item.checked);
                }

                const labelPrefix = item.type === "toggle" ? (checked ? "[x] " : "[ ] ") : "";
                const action = () => {
                    item.action?.();
                    onClose?.();
                };

                renderEntries.push(
                    React.createElement(
                        "button",
                        {
                            key,
                            type: "button",
                            disabled: item.disabled === true,
                            onClick: action,
                            style: {
                                display: "block",
                                width: "100%",
                                textAlign: "left",
                                padding: "6px 8px",
                                background: "transparent",
                                color: "inherit",
                                border: "none",
                                cursor: "pointer"
                            }
                        },
                        `${labelPrefix}${typeof item.label === "string" ? item.label : ""}`,
                        typeof item.label === "string" || item.label == null ? null : item.label
                    )
                );
            }

            return renderEntries;
        };

        const buildFallbackMenu = (items: BdMenuItem[]) =>
            (props: { onClose?: () => void; } = {}) =>
                React.createElement(
                    "div",
                    { style: { minWidth: 180, padding: 4 } },
                    ...renderFallbackMenuItems(items, props.onClose)
                );

        const getContextMenuModule = () => {
            const contextMenu = webpackApi.getModule((module: unknown) =>
                !!module &&
                typeof module === "object" &&
                typeof (module as Record<string, unknown>).buildMenu === "function" &&
                typeof (module as Record<string, unknown>).buildMenuChildren === "function",
            { searchExports: true });
            return contextMenu && typeof contextMenu === "object"
                ? contextMenu as Record<string, unknown>
                : null;
        };

        const contextMenuApi = {
            get Item() {
                return Menu.MenuItem;
            },
            buildMenu: (items: unknown) => {
                const normalizedItems = Array.isArray(items) ? items as BdMenuItem[] : [];
                const contextMenuModule = getContextMenuModule();
                const buildMenu = contextMenuModule?.buildMenu;

                if (typeof buildMenu === "function") {
                    return buildMenu.call(contextMenuModule, normalizedItems);
                }

                return buildFallbackMenu(normalizedItems);
            },
            buildMenuChildren: (items: unknown) => {
                const normalizedItems = Array.isArray(items) ? items as BdMenuItem[] : [];
                const contextMenuModule = getContextMenuModule();
                const buildMenuChildren = contextMenuModule?.buildMenuChildren;

                if (typeof buildMenuChildren === "function") {
                    return buildMenuChildren.call(contextMenuModule, normalizedItems);
                }

                return renderFallbackMenuItems(normalizedItems);
            },
            open: (event: unknown, menu: unknown) => {
                const contextMenuModule = getContextMenuModule();
                const open = contextMenuModule?.open;

                if (typeof open === "function") {
                    return open.call(contextMenuModule, event, menu);
                }

                if (typeof menu !== "function") return;
                ContextMenuApi.openContextMenu(event as never, menu as never);
            },
            patch: (navId: unknown, callback: unknown) => {
                const navIds = Array.isArray(navId)
                    ? navId.filter((id): id is string => typeof id === "string" && id.length > 0)
                    : typeof navId === "string" && navId.length > 0
                        ? [navId]
                        : [];
                if (!navIds.length || typeof callback !== "function") {
                    logger.warn("BdApi.ContextMenu.patch called with invalid arguments.");
                    return () => void 0;
                }

                const wrappedPatch: Parameters<typeof addContextMenuPatch>[1] = (children, ...args) => {
                    const menuRoot = { props: { children } };

                    try {
                        (callback as (menuRoot: { props: { children: unknown; }; }, ...args: unknown[]) => void)(menuRoot, ...args);
                    } catch (error) {
                        logger.error("Failed to execute BdApi.ContextMenu.patch callback.", error);
                    }
                };

                addContextMenuPatch(navIds, wrappedPatch);
                return () => {
                    removeContextMenuPatch(navIds, wrappedPatch);
                };
            }
        };

        const renderChangelogBody = (options?: BdChangelogModalOptions) => {
            if (!options) return null;

            const sections: React.ReactNode[] = [];

            if (options.subtitle) {
                sections.push(
                    React.createElement("div", { key: "subtitle", style: { opacity: 0.8, marginBottom: 4 } }, options.subtitle)
                );
            }

            if (options.blurb) {
                sections.push(React.createElement("div", { key: "blurb", style: { marginBottom: 8 } }, options.blurb));
            }

            if (Array.isArray(options.changes)) {
                options.changes.forEach((change, index) => {
                    const title = change?.title ?? change?.type ?? `Change ${index + 1}`;
                    const items = Array.isArray(change?.items) ? change.items : [];

                    sections.push(
                        React.createElement(
                            "div",
                            { key: `change-${index}`, style: { marginBottom: 8 } },
                            React.createElement("strong", null, title),
                            items.length
                                ? React.createElement(
                                    "ul",
                                    { style: { marginTop: 4, marginBottom: 0, paddingLeft: 18 } },
                                    ...items.map((item, itemIndex) =>
                                        React.createElement("li", { key: `change-${index}-item-${itemIndex}` }, String(item))
                                    )
                                )
                                : null
                        )
                    );
                });
            }

            return React.createElement("div", null, ...sections);
        };

        const toReactNodeArray = (value: unknown): React.ReactNode[] => {
            if (value === null || value === undefined) return [];
            return Array.isArray(value)
                ? value as React.ReactNode[]
                : [value as React.ReactNode];
        };

        const buildSettingsPanel = (options?: { settings?: unknown[]; onChange?: (...args: unknown[]) => void; }) => {
            const settings = Array.isArray(options?.settings) ? options.settings : [];

            return React.createElement(
                "div",
                { className: "bd-compat-settings-panel" },
                ...settings.map((setting, index) => {
                    const descriptor = setting && typeof setting === "object"
                        ? setting as Record<string, unknown>
                        : {};
                    const key = typeof descriptor.id === "string" ? descriptor.id : `setting-${index}`;
                    const children = toReactNodeArray(descriptor.children);

                    return React.createElement(
                        "div",
                        {
                            key,
                            className: "bd-setting-item",
                            style: { marginBottom: 12 }
                        },
                        React.createElement(
                            "div",
                            { className: "bd-setting-header", style: { fontWeight: 600 } },
                            descriptor.name as React.ReactNode
                        ),
                        descriptor.note == null
                            ? null
                            : React.createElement(
                                "div",
                                { className: "bd-setting-note", style: { opacity: 0.8, marginTop: 4, marginBottom: 6 } },
                                descriptor.note as React.ReactNode
                            ),
                        ...children
                    );
                })
            );
        };

        const resolveInviteCode = (invite: unknown) => {
            if (typeof invite === "string" && invite.length) return invite;
            if (!invite || typeof invite !== "object") return null;

            const inviteRecord = invite as Record<string, unknown>;
            const inviteCode = inviteRecord.code ?? inviteRecord.invite ?? inviteRecord.inviteCode;
            return typeof inviteCode === "string" && inviteCode.length
                ? inviteCode
                : null;
        };

        const pluginsApi = {
            folder: "",
            isEnabled: (name: string) => {
                const targetName = String(name);
                const settingsPlugins = (globalThis as {
                    Vencord?: { Settings?: { plugins?: Record<string, { enabled?: boolean; }>; }; };
                }).Vencord?.Settings?.plugins;

                const maybeEnabled = settingsPlugins?.[targetName]?.enabled;
                return maybeEnabled ?? true;
            }
        };

        const sharedApi = {
            Webpack: webpackApi,
            React,
            Components: {
                TextInput: WebpackCommon.TextInput,
                Tooltip: WebpackCommon.Tooltip
            },
            Hooks: { useStateFromStores },
            Utils: { findInTree },
            Data: dataApi,
            Commands: commandApi,
            ContextMenu: contextMenuApi,
            Patcher: {
                after: (...args: unknown[]) => patcher.after(...args),
                before: (...args: unknown[]) => patcher.before(...args),
                instead: (...args: unknown[]) => patcher.instead(...args),
                unpatchAll: () => patcher.unpatchAll()
            },
            DOM: {
                addStyle: (...args: unknown[]) => {
                    if (!args.length) {
                        logger.warn("BdApi.DOM.addStyle called without CSS.");
                        return;
                    }

                    if (args.length === 1) {
                        styles.addStyle(defaultLegacyStyleId, String(args[0] ?? ""));
                        return;
                    }

                    const [id, css] = args;
                    styles.addStyle(String(id ?? defaultLegacyStyleId), String(css ?? ""));
                },
                removeStyle: (...args: unknown[]) => {
                    if (!args.length) {
                        styles.removeStyle(defaultLegacyStyleId);
                        return;
                    }

                    styles.removeStyle(String(args[0] ?? defaultLegacyStyleId));
                },
                parseHTML: (html: string) => {
                    if (typeof document === "undefined") return null;

                    const template = document.createElement("template");
                    template.innerHTML = String(html).trim();
                    return template.content.firstElementChild ?? template.content.firstChild;
                }
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
                showToast: (message: string, options?: { type?: string; timeout?: number; }) => showToast(String(message), toToastType(options?.type), options?.timeout ? { duration: options.timeout } : undefined),
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
                }),
                buildSettingsPanel,
                showNotice: (content: unknown, options?: BdNoticeOptions) => {
                    const message = toNoticeText(content);
                    showToast(message || "Notice", toToastType(options?.type), options?.timeout ? { duration: options.timeout } : undefined);
                    return () => void 0;
                },
                showInviteModal: (invite: unknown) => {
                    const inviteCode = resolveInviteCode(invite);
                    if (!inviteCode) {
                        logger.warn("BdApi.UI.showInviteModal called without an invite code.");
                        return;
                    }

                    const inviteModule = webpackApi.getByKeys("openInviteModal");
                    if (inviteModule && typeof inviteModule.openInviteModal === "function") {
                        try {
                            inviteModule.openInviteModal(inviteCode);
                            return;
                        } catch {
                            try {
                                inviteModule.openInviteModal({ inviteCode, code: inviteCode });
                                return;
                            } catch (error) {
                                logger.error("Failed to open Discord invite modal.", error);
                            }
                        }
                    }

                    if (typeof window !== "undefined" && typeof window.open === "function") {
                        window.open(`https://discord.gg/${inviteCode}`, "_blank", "noopener,noreferrer");
                    }
                },
                showChangelogModal: (options?: BdChangelogModalOptions) => Alerts.show({
                    title: options?.title ?? pluginName,
                    body: renderChangelogBody(options),
                    confirmText: "OK"
                })
            },
            Plugins: pluginsApi,
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

        const bdApi = Object.assign(BdApiCtor, sharedApi);
        this.apiInstances.set(pluginName, bdApi);
        return bdApi;
    }

    dispose() {
        for (const patcher of this.patchers) patcher.unpatchAll();
        for (const styleManager of this.styles) styleManager.clear();
        for (const cleanup of this.cleanups) {
            try {
                cleanup();
            } catch (error) {
                this.logger.error("Failed to execute BdApi runtime cleanup.", error);
            }
        }
        this.patchers.clear();
        this.styles.clear();
        this.cleanups.clear();
        this.apiInstances.clear();
    }
}

function loadLegacyPlugin(source: string, bdApi: unknown, pluginName: string, logger: Logger) {
    const module = { exports: {} as unknown };
    const localStorage = resolveLocalStorage();
    const globalScope = typeof globalThis === "undefined" ? {} : globalThis;
    const windowScope = typeof window === "undefined" ? globalScope : window;
    const requireShim = createLegacyRequireShim(pluginName, logger);
    const pluginFactory = getLegacyPluginFactory(source);
    const restoreLegacyBdApi = bindLegacyBdApi(bdApi, getLegacyGlobalScopes(windowScope, globalScope));

    try {
        pluginFactory(module, module.exports, bdApi, windowScope, globalScope, globalScope, localStorage, requireShim);
    } finally {
        restoreLegacyBdApi();
    }

    const exported = module.exports as { default?: unknown; };
    return exported.default ?? exported;
}

interface LegacyBdPluginInstance {
    start?: () => void;
    stop?: () => void;
    getSettingsPanel?: () => unknown;
}

export interface BdPluginBridge {
    start: () => void;
    stop: () => void;
    settingsAboutComponent: React.ComponentType;
}

export function createBdPluginBridge(pluginName: string, source: string): BdPluginBridge {
    const logger = new Logger(pluginName);
    let runtime: BdRuntime | null = null;
    let legacyInstance: LegacyBdPluginInstance | null = null;

    const LegacySettingsDomHost = ({ panel }: { panel: Node; }) => {
        const containerRef = React.useRef<HTMLDivElement | null>(null);

        React.useEffect(() => {
            const container = containerRef.current;
            if (!container) return;

            container.replaceChildren(panel);
            return () => {
                if (panel.parentNode === container) {
                    container.removeChild(panel);
                }
            };
        }, [panel]);

        return React.createElement("div", { ref: containerRef });
    };

    const getLegacySettingsPanel = () => {
        const panelGetter = legacyInstance?.getSettingsPanel;
        if (typeof panelGetter !== "function") return null;

        try {
            const panel = panelGetter.call(legacyInstance);
            return typeof panel === "function"
                ? (panel as () => unknown)()
                : panel;
        } catch (error) {
            logger.error("Failed to render legacy BetterDiscord settings panel.", error);
            return null;
        }
    };

    const renderLegacySettingsPanel = (panel: unknown) => {
        if (panel == null || panel === false) return null;
        if (React.isValidElement(panel)) return panel;

        if (typeof panel === "string") {
            if (!panel.length) return null;

            return React.createElement("div", {
                dangerouslySetInnerHTML: { __html: panel }
            });
        }

        if (typeof Node !== "undefined" && panel instanceof Node) {
            return React.createElement(LegacySettingsDomHost, { panel });
        }

        if (typeof panel === "number" || typeof panel === "boolean") {
            return React.createElement("span", null, String(panel));
        }

        return null;
    };

    const LegacySettingsAboutComponent = () => {
        if (!legacyInstance) {
            return React.createElement(
                "div",
                { style: { opacity: 0.8 } },
                "Enable this plugin to access its legacy settings panel."
            );
        }

        const renderedPanel = renderLegacySettingsPanel(getLegacySettingsPanel());
        if (renderedPanel != null) {
            return renderedPanel;
        }

        return React.createElement(
            "div",
            { style: { opacity: 0.8 } },
            "This legacy plugin does not expose a settings panel."
        );
    };

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
            legacyInstance = new (LegacyPluginCtor as new (...args: unknown[]) => LegacyBdPluginInstance)({ name: pluginName });
            legacyInstance.start?.();
        } catch (error) {
            logger.error("Failed to start legacy BetterDiscord plugin.", error);
            stop();
        }
    };

    return {
        start,
        stop,
        settingsAboutComponent: LegacySettingsAboutComponent as React.ComponentType
    };
}
