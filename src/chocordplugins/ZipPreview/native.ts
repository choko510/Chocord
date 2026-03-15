/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { IpcMainInvokeEvent } from "electron";

type SerializableRequestInit = Pick<RequestInit, "headers" | "method">;

interface NativeFetchResponse {
    data: ArrayBuffer;
    headers: Record<string, string>;
    ok: boolean;
    status: number;
    statusText: string;
}

export async function fetchFile(_: IpcMainInvokeEvent, url: string, init?: SerializableRequestInit): Promise<NativeFetchResponse> {
    const response = await fetch(url, init);
    const data = await response.arrayBuffer();

    return {
        data,
        headers: Object.fromEntries(response.headers.entries()),
        ok: response.ok,
        status: response.status,
        statusText: response.statusText
    };
}
