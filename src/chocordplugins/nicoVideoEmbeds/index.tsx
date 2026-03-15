/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { BaseText } from "@components/BaseText";
import { Card } from "@components/Card";
import ErrorBoundary from "@components/ErrorBoundary";
import { EquicordDevs } from "@utils/constants";
import { classNameFactory } from "@utils/css";
import { Logger } from "@utils/Logger";
import { classes, parseUrl } from "@utils/misc";
import definePlugin, { PluginNative } from "@utils/types";
import { Message } from "@vencord/discord-types";
import { useEffect, useState } from "@webpack/common";

const cl = classNameFactory("vc-nico-video-embeds-");
const logger = new Logger("NicoVideoEmbeds");
const Native = VencordNative.pluginHelpers.NicoVideoEmbeds as PluginNative<typeof import("./native")>;
const validVideoIdPattern = /^(?:[a-z]{2}\d+|\d+)$/i;
const nicoWatchHosts = new Set(["nicovideo.jp", "www.nicovideo.jp"]);
const nicoShortHosts = new Set(["nico.ms", "www.nico.ms"]);
const nicoContentUrlPattern = "https?:\\/\\/(?:www\\.)?(?:nicovideo\\.jp\\/watch\\/(?:[a-z]{2}\\d+|\\d+)|nico\\.ms\\/(?:[a-z]{2}\\d+|\\d+))[^\\s<]*";
const trailingPunctuationRegex = /[),.;!?]+$/;
const genericErrorMessage = "ニコニコ動画情報の取得に失敗しました。";
const countFormatter = new Intl.NumberFormat("ja-JP");
const dateFormatter = new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "medium",
    timeStyle: "short"
});

interface NicoVideoCardPayload {
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

interface NicoVideoCardData {
    commentCount: string;
    postedAt: string;
    tags: string[];
    thumbnailUrl: string;
    title: string;
    uploaderName: string;
    uploaderUrl: string;
    url: string;
    videoId: string;
    viewCount: string;
}

interface NicoVideoReference {
    url: string;
    videoId: string;
}

type NicoVideoCardState =
    | { status: "loading"; }
    | { data: NicoVideoCardData; status: "loaded"; }
    | { status: "error"; };

const nicoCardCache = new Map<string, NicoVideoCardData>();
const nicoCardRequests = new Map<string, Promise<NicoVideoCardData>>();

const canonicalNicoVideoUrl = (videoId: string) => `https://www.nicovideo.jp/watch/${videoId}`;
const canonicalNicoTagUrl = (tag: string) => `https://www.nicovideo.jp/tag/${encodeURIComponent(tag)}`;

const formatCount = (count: number | null) => count == null
    ? "不明"
    : countFormatter.format(count);

const formatPostedAt = (postedAt: string) => {
    if (!postedAt) return "不明";
    const timestamp = Date.parse(postedAt);
    if (Number.isNaN(timestamp)) return postedAt;
    return dateFormatter.format(timestamp);
};

const normalizeVideoId = (videoId: string) => videoId.toLowerCase();

const getNicoVideoId = (url: string) => {
    const parsedUrl = parseUrl(url);
    if (!parsedUrl) return null;

    const hostname = parsedUrl.hostname.toLowerCase();
    const pathParts = parsedUrl.pathname.split("/").filter(Boolean);
    let videoId = "";

    if (nicoWatchHosts.has(hostname)) {
        const watchIndex = pathParts.indexOf("watch");
        if (watchIndex === -1) return null;
        videoId = pathParts[watchIndex + 1] ?? "";
    } else if (nicoShortHosts.has(hostname)) {
        videoId = pathParts[0] ?? "";
    } else {
        return null;
    }

    if (!validVideoIdPattern.test(videoId)) return null;
    return normalizeVideoId(videoId);
};

const extractNicoVideoUrls = (content: string) => {
    if (!content) return [] as string[];
    const regex = new RegExp(nicoContentUrlPattern, "gi");
    return [...content.matchAll(regex)].map(([rawUrl]) => rawUrl.replace(trailingPunctuationRegex, ""));
};

const collectNicoVideoReferences = (message: Message): NicoVideoReference[] => {
    const references = new Map<string, string>();

    for (const url of extractNicoVideoUrls(message.content ?? "")) {
        const videoId = getNicoVideoId(url);
        if (!videoId || references.has(videoId)) continue;
        references.set(videoId, canonicalNicoVideoUrl(videoId));
    }

    for (const { url } of message.embeds ?? []) {
        if (!url) continue;
        const videoId = getNicoVideoId(url);
        if (!videoId || references.has(videoId)) continue;
        references.set(videoId, canonicalNicoVideoUrl(videoId));
    }

    return [...references.entries()].map(([videoId, url]) => ({ url, videoId }));
};

const fetchNicoVideoPayload = (videoId: string) => {
    if (IS_WEB) {
        throw new Error("NicoNico metadata is unavailable on web.");
    }

    return Native.getNicoVideoCardPayload(videoId) as Promise<NicoVideoCardPayload>;
};

const fetchNicoVideoCard = async (videoId: string) => {
    const cached = nicoCardCache.get(videoId);
    if (cached) return cached;

    const pending = nicoCardRequests.get(videoId);
    if (pending) return pending;

    const request = (async () => {
        const payload = await fetchNicoVideoPayload(videoId);
        const card: NicoVideoCardData = {
            commentCount: formatCount(payload.commentCount),
            postedAt: formatPostedAt(payload.postedAt),
            tags: payload.tags,
            thumbnailUrl: payload.thumbnailUrl,
            title: payload.title,
            uploaderName: payload.uploaderName || "投稿者不明",
            uploaderUrl: payload.uploaderUrl,
            url: canonicalNicoVideoUrl(videoId),
            videoId,
            viewCount: formatCount(payload.viewCount)
        };

        nicoCardCache.set(videoId, card);
        return card;
    })().finally(() => {
        nicoCardRequests.delete(videoId);
    });

    nicoCardRequests.set(videoId, request);
    return request;
};

interface NicoVideoCardProps {
    url: string;
    videoId: string;
}

const NicoVideoCard = ErrorBoundary.wrap(({ url, videoId }: NicoVideoCardProps) => {
    const cached = nicoCardCache.get(videoId);
    const [state, setState] = useState<NicoVideoCardState>(cached
        ? { data: cached, status: "loaded" }
        : { status: "loading" });

    useEffect(() => {
        const cachedData = nicoCardCache.get(videoId);
        if (cachedData) {
            setState({ data: cachedData, status: "loaded" });
            return () => void 0;
        }

        let didCleanup = false;
        setState({ status: "loading" });

        void fetchNicoVideoCard(videoId)
            .then(data => {
                if (didCleanup) return;
                setState({ data, status: "loaded" });
            })
            .catch(error => {
                logger.error(`Failed to load NicoNico card for ${videoId}`, error);
                if (didCleanup) return;
                setState({ status: "error" });
            });

        return () => {
            didCleanup = true;
        };
    }, [videoId]);

    if (state.status === "loading") {
        return <Card className={cl("card")}>
            <BaseText size="sm" className={cl("status")}>ニコニコ動画情報を読み込み中です...</BaseText>
        </Card>;
    }

    if (state.status === "error") {
        return <Card className={cl("card")}>
            <BaseText size="sm" className={classes(cl("status"), cl("status-error"))}>{genericErrorMessage}</BaseText>
        </Card>;
    }

    const { data } = state;

    return <Card className={cl("card")}>
        <div className={cl("top")}>
            {data.thumbnailUrl
                ? <img src={data.thumbnailUrl} alt="" className={cl("thumbnail")} />
                : <div className={classes(cl("thumbnail"), cl("thumbnail-fallback"))}>NICO</div>
            }
            <div className={cl("top-content")}>
                <a href={url} target="_blank" rel="noreferrer" className={cl("title")}>
                    {data.title}
                </a>
                {data.uploaderUrl
                    ? <a href={data.uploaderUrl} target="_blank" rel="noreferrer" className={classes(cl("uploader"), cl("text-link"))}>
                        {data.uploaderName}
                    </a>
                    : <BaseText size="sm" className={cl("uploader")}>{data.uploaderName}</BaseText>
                }
            </div>
        </div>

        <div className={cl("meta-grid")}>
            <div className={cl("meta-item")}>
                <BaseText size="xs" className={cl("meta-label")}>再生数</BaseText>
                <BaseText size="sm" className={cl("meta-value")}>{data.viewCount}</BaseText>
            </div>
            <div className={cl("meta-item")}>
                <BaseText size="xs" className={cl("meta-label")}>コメント数</BaseText>
                <BaseText size="sm" className={cl("meta-value")}>{data.commentCount}</BaseText>
            </div>
            <div className={cl("meta-item")}>
                <BaseText size="xs" className={cl("meta-label")}>投稿者</BaseText>
                {data.uploaderUrl
                    ? <a href={data.uploaderUrl} target="_blank" rel="noreferrer" className={classes(cl("meta-value"), cl("text-link"))}>
                        {data.uploaderName}
                    </a>
                    : <BaseText size="sm" className={cl("meta-value")}>{data.uploaderName}</BaseText>
                }
            </div>
            <div className={cl("meta-item")}>
                <BaseText size="xs" className={cl("meta-label")}>投稿日時</BaseText>
                <BaseText size="sm" className={cl("meta-value")}>{data.postedAt}</BaseText>
            </div>
        </div>

        <div className={cl("tags-wrap")}>
            <BaseText size="xs" className={cl("meta-label")}>タグ</BaseText>
            {data.tags.length
                ? <div className={cl("tags")}>
                    {data.tags.map(tag => (
                        <a
                            key={`${data.videoId}:${tag}`}
                            href={canonicalNicoTagUrl(tag)}
                            target="_blank"
                            rel="noreferrer"
                            className={cl("tag")}
                        >
                            {tag}
                        </a>
                    ))}
                </div>
                : <BaseText size="sm" className={cl("meta-value")}>タグなし</BaseText>
            }
        </div>
    </Card>;
}, { noop: true });

export default definePlugin({
    name: "NicoVideoEmbeds",
    description: "Replaces NicoNico watch embeds with readable metadata cards.",
    authors: [EquicordDevs.niko],
    patches: [
        {
            find: "renderEmbeds(",
            predicate: () => !IS_WEB,
            replacement: {
                match: /(?<=renderEmbeds\(\i\){.{0,2000}embeds\.map\(\((\i),\i\)?=>{)/,
                replace: "$&if($self.isNicoVideoEmbed($1))return null;"
            }
        }
    ],
    isNicoVideoEmbed(embed: { url?: string; }) {
        return typeof embed?.url === "string" && getNicoVideoId(embed.url) != null;
    },
    renderMessageAccessory(props) {
        if (IS_WEB) return null;

        const { message } = props as { message?: Message; };
        if (!message) return null;

        const references = collectNicoVideoReferences(message);
        if (!references.length) return null;

        return <div className={cl("list")}>
            {references.map(({ url, videoId }) => (
                <NicoVideoCard
                    key={videoId}
                    url={url}
                    videoId={videoId}
                />
            ))}
        </div>;
    },
    stop() {
        nicoCardCache.clear();
        nicoCardRequests.clear();
    }
});
