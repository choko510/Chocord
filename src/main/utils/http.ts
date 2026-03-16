/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2022 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { createWriteStream } from "original-fs";
import { Readable } from "stream";
import { finished } from "stream/promises";

type Url = string | URL;
type FetchOptions = RequestInit & {
    timeoutMs?: number;
};

function prepareRequest(options?: FetchOptions): {
    request: RequestInit | undefined;
    timeoutMs?: number;
    cleanup: () => void;
} {
    if (!options) {
        return {
            request: undefined,
            cleanup: () => { }
        };
    }

    const { timeoutMs, signal, ...request } = options;

    if (timeoutMs == null && !signal) {
        return {
            request,
            timeoutMs,
            cleanup: () => { }
        };
    }

    const controller = new AbortController();
    let timeout: NodeJS.Timeout | undefined;
    let abortListener: (() => void) | undefined;

    if (signal) {
        if (signal.aborted) {
            controller.abort(signal.reason);
        } else {
            abortListener = () => controller.abort(signal.reason);
            signal.addEventListener("abort", abortListener, { once: true });
        }
    }

    if (timeoutMs != null) {
        timeout = setTimeout(() => {
            controller.abort(new Error(`Request timed out after ${timeoutMs}ms`));
        }, timeoutMs);
    }

    return {
        request: {
            ...request,
            signal: controller.signal
        },
        timeoutMs,
        cleanup: () => {
            if (timeout) clearTimeout(timeout);
            if (signal && abortListener) {
                signal.removeEventListener("abort", abortListener);
            }
        }
    };
}

export async function checkedFetch(url: Url, options?: FetchOptions) {
    const method = options?.method ?? "GET";
    const { request, timeoutMs, cleanup } = prepareRequest(options);

    try {
        var res = await fetch(url, request);
    } catch (err) {
        if (err instanceof Error && err.name === "AbortError" && timeoutMs != null) {
            throw new Error(`${method} ${url} failed: Request timed out after ${timeoutMs}ms`);
        }

        if (err instanceof Error && err.cause) {
            err = err.cause;
        }

        throw new Error(`${method} ${url} failed: ${err}`);
    } finally {
        cleanup();
    }

    if (res.ok) {
        return res;
    }

    let message = `${method} ${url}: ${res.status} ${res.statusText}`;
    try {
        const reason = await res.text();
        message += `\n${reason}`;
    } catch { }

    throw new Error(message);
}

export async function fetchJson<T = any>(url: Url, options?: FetchOptions) {
    const res = await checkedFetch(url, options);
    return res.json() as Promise<T>;
}

export async function fetchBuffer(url: Url, options?: FetchOptions) {
    const res = await checkedFetch(url, options);
    const buf = await res.arrayBuffer();

    return Buffer.from(buf);
}

export async function downloadToFile(url: Url, path: string, options?: FetchOptions) {
    const res = await checkedFetch(url, options);
    if (!res.body) {
        throw new Error(`Download ${url}: response body is empty`);
    }

    // @ts-expect-error weird type conflict
    const body = Readable.fromWeb(res.body);
    await finished(body.pipe(createWriteStream(path)));
}
