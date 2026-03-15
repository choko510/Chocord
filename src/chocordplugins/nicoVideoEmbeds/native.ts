/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { IpcMainInvokeEvent } from "electron";

interface NicoVideoCount {
    comment?: number | string;
    view?: number | string;
}

interface NicoVideoTagItem {
    name?: string;
}

interface NicoVideoTag {
    items?: NicoVideoTagItem[];
}

interface NicoVideoThumbnail {
    largeUrl?: string;
    middleUrl?: string;
    ogp?: string;
    player?: string;
    url?: string;
}

interface NicoVideo {
    count?: NicoVideoCount;
    registeredAt?: string;
    registered_at?: string;
    tag?: NicoVideoTag;
    tags?: unknown;
    thumbnail?: NicoVideoThumbnail;
    title?: string;
}

interface NicoOwner {
    id?: number | string;
    nickname?: string;
    url?: string;
    user?: {
        id?: number | string;
        url?: string;
    };
}

interface NicoChannel {
    id?: number | string;
    name?: string;
    url?: string;
}

interface NicoWatchPayload {
    channel?: NicoChannel | null;
    owner?: NicoOwner | null;
    tag?: unknown;
    tags?: unknown;
    video?: NicoVideo;
}

interface NicoWatchResponse {
    data?: {
        response?: NicoWatchPayload;
    };
    meta?: {
        status?: number;
    };
}

export interface NicoVideoCardPayload {
    commentCount: number | null;
    postedAt: string;
    tags: string[];
    thumbnailUrl: string;
    title: string;
    uploaderName: string;
    uploaderUrl: string;
    videoId: string;
    viewCount: number | null;
}

const validVideoIdPattern = /^(?:[a-z]{2}\d+|\d+)$/i;

const firstNonEmptyString = (...values: Array<string | null | undefined>) =>
    values.find(value => typeof value === "string" && value.trim().length > 0)?.trim() ?? "";

const parseCount = (count: number | string | undefined) => {
    if (typeof count === "number") {
        if (!Number.isFinite(count) || count < 0) return null;
        return Math.trunc(count);
    }

    if (typeof count !== "string") return null;

    const parsed = Number.parseInt(count, 10);
    if (Number.isNaN(parsed) || parsed < 0) return null;
    return parsed;
};

const normalizeIdValue = (value: number | string | undefined) => {
    if (typeof value === "number") {
        if (!Number.isFinite(value) || value <= 0) return "";
        return `${Math.trunc(value)}`;
    }

    if (typeof value !== "string") return "";
    return value.trim();
};

const normalizeTags = (items: NicoVideoTagItem[] | undefined) => {
    if (!items?.length) return [] as string[];
    return [...new Set(items
        .map(({ name }) => name?.trim())
        .filter((tag): tag is string => Boolean(tag)))];
};

const extractTagsFromCandidate = (candidate: unknown, tags: Set<string>): void => {
    if (typeof candidate === "string") {
        const normalized = candidate.trim();
        if (normalized) tags.add(normalized);
        return;
    }

    if (Array.isArray(candidate)) {
        candidate.forEach(entry => extractTagsFromCandidate(entry, tags));
        return;
    }

    if (!candidate || typeof candidate !== "object") return;

    const record = candidate as Record<string, unknown>;
    const { name } = record;
    if (typeof name === "string" && name.trim()) {
        tags.add(name.trim());
    }

    extractTagsFromCandidate(record.items, tags);
    extractTagsFromCandidate(record.item, tags);
    extractTagsFromCandidate(record.tag, tags);
    extractTagsFromCandidate(record.tags, tags);
};

const extractTags = (...candidates: unknown[]) => {
    const tags = new Set<string>();
    candidates.forEach(candidate => extractTagsFromCandidate(candidate, tags));
    return [...tags];
};

const toNicoUserUrl = (userId: string) => `https://www.nicovideo.jp/user/${encodeURIComponent(userId)}`;

const toNicoChannelUrl = (channelId: string) => {
    if (/^ch\d+$/i.test(channelId)) {
        return `https://ch.nicovideo.jp/${channelId.toLowerCase()}`;
    }

    if (/^\d+$/.test(channelId)) {
        return `https://ch.nicovideo.jp/ch${channelId}`;
    }

    return `https://ch.nicovideo.jp/${encodeURIComponent(channelId)}`;
};

const resolveUploaderUrl = (payload: NicoWatchPayload) => {
    const ownerUrl = firstNonEmptyString(payload.owner?.url, payload.owner?.user?.url);
    if (ownerUrl) return ownerUrl;

    const channelUrl = firstNonEmptyString(payload.channel?.url);
    if (channelUrl) return channelUrl;

    const ownerId = normalizeIdValue(payload.owner?.id ?? payload.owner?.user?.id);
    if (ownerId) return toNicoUserUrl(ownerId);

    const channelId = normalizeIdValue(payload.channel?.id);
    if (channelId) return toNicoChannelUrl(channelId);

    return "";
};

async function fetchNicoWatchPayload(videoId: string): Promise<NicoWatchPayload> {
    const requestUrl = new URL(`https://www.nicovideo.jp/watch/${videoId}`);
    requestUrl.searchParams.set("responseType", "json");

    const response = await fetch(requestUrl.toString(), {
        headers: {
            accept: "application/json, text/plain, */*"
        }
    });

    if (!response.ok) {
        throw new Error(`NicoNico watch API returned ${response.status}.`);
    }

    const body = await response.json() as NicoWatchResponse;
    if (body.meta?.status != null && body.meta.status !== 200) {
        throw new Error(`NicoNico watch API returned ${body.meta.status}.`);
    }

    const payload = body.data?.response;
    if (!payload?.video?.title) {
        throw new Error("NicoNico watch payload is unavailable.");
    }

    return payload;
}

export async function getNicoVideoCardPayload(_: IpcMainInvokeEvent, videoId: string): Promise<NicoVideoCardPayload> {
    if (!validVideoIdPattern.test(videoId)) {
        throw new Error("Invalid NicoNico video ID.");
    }

    const payload = await fetchNicoWatchPayload(videoId);
    const { video } = payload;
    const thumbnailUrl = firstNonEmptyString(
        video?.thumbnail?.ogp,
        video?.thumbnail?.largeUrl,
        video?.thumbnail?.middleUrl,
        video?.thumbnail?.player,
        video?.thumbnail?.url
    );

    const normalizedTags = extractTags(
        video?.tag?.items,
        video?.tag,
        video?.tags,
        payload.tag,
        payload.tags
    );

    return {
        commentCount: parseCount(video?.count?.comment),
        postedAt: firstNonEmptyString(video?.registeredAt, video?.registered_at),
        tags: normalizedTags.length ? normalizedTags : normalizeTags(video?.tag?.items),
        thumbnailUrl,
        title: video?.title?.trim() ?? "",
        uploaderName: firstNonEmptyString(payload.owner?.nickname, payload.channel?.name) || "投稿者不明",
        uploaderUrl: resolveUploaderUrl(payload),
        videoId,
        viewCount: parseCount(video?.count?.view)
    };
}
