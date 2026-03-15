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

const cl = classNameFactory("vc-steam-store-embeds-");
const logger = new Logger("SteamStoreEmbeds");
const Native = VencordNative.pluginHelpers.SteamStoreEmbeds as PluginNative<typeof import("./native")>;
const steamStoreHosts = new Set(["store.steampowered.com", "www.store.steampowered.com"]);
const steamContentUrlPattern = "https?:\\/\\/store\\.steampowered\\.com\\/(?:agecheck\\/)?app\\/\\d+[^\\s<]*";
const trailingPunctuationRegex = /[),.;!?]+$/;
const genericErrorMessage = "Steam 情報の取得に失敗しました。";
const yenFormatter = new Intl.NumberFormat("ja-JP", {
    style: "currency",
    currency: "JPY"
});

interface SteamPriceOverview {
    currency: string;
    discount_percent: number;
    final: number;
    final_formatted: string;
}

interface SteamReleaseDate {
    coming_soon: boolean;
    date: string;
}

interface SteamGenre {
    description: string;
}

interface SteamAppDetails {
    developers?: string[];
    genres?: SteamGenre[];
    header_image?: string;
    is_free: boolean;
    name: string;
    price_overview?: SteamPriceOverview;
    release_date?: SteamReleaseDate;
    short_description?: string;
}

interface SteamReviewSummary {
    review_score_desc: string;
    total_positive: number;
    total_reviews: number;
}

interface SteamCardData {
    appId: number;
    description: string;
    developers: string;
    genres: string;
    imageUrl: string;
    name: string;
    price: string;
    rating: string;
    releaseDate: string;
    url: string;
}

interface SteamReference {
    appId: number;
    url: string;
}

type SteamCardState =
    | { status: "loading"; }
    | { status: "loaded"; data: SteamCardData; }
    | { status: "error"; };

const steamCardCache = new Map<number, SteamCardData>();
const steamCardRequests = new Map<number, Promise<SteamCardData>>();

const formatList = (values: string[] | undefined, fallback: string) => {
    if (!values?.length) return fallback;
    const visible = values.slice(0, 3).join("、");
    return values.length > 3 ? `${visible} ほか${values.length - 3}件` : visible;
};

const formatReleaseDate = (releaseDate: SteamReleaseDate | undefined) => {
    if (!releaseDate?.date) return "未定";
    return releaseDate.coming_soon ? `${releaseDate.date}（予定）` : releaseDate.date;
};

const formatPrice = (details: SteamAppDetails) => {
    if (details.is_free) return "基本プレイ無料";

    const { price_overview } = details;
    if (!price_overview) return details.release_date?.coming_soon ? "未定" : "価格情報なし";

    const discount = price_overview.discount_percent > 0
        ? `（${price_overview.discount_percent}%オフ）`
        : "";

    if (price_overview.final_formatted) {
        return `${price_overview.final_formatted}${discount}`;
    }

    if (price_overview.currency === "JPY") {
        return `${yenFormatter.format(price_overview.final)}${discount}`;
    }

    return `${price_overview.final.toLocaleString("ja-JP")} ${price_overview.currency}${discount}`;
};

const formatGenres = (genres: SteamGenre[] | undefined) => formatList(genres?.map(({ description }) => description), "不明");

const formatRating = (summary: SteamReviewSummary | null) => {
    if (!summary || !summary.total_reviews) return "評価情報なし";
    const positiveRate = Math.round(summary.total_positive / summary.total_reviews * 100);
    return `${summary.review_score_desc} (${positiveRate}% / ${summary.total_reviews.toLocaleString("ja-JP")}件)`;
};

const canonicalSteamUrl = (appId: number) => `https://store.steampowered.com/app/${appId}/`;

const getSteamStoreAppId = (url: string) => {
    const parsedUrl = parseUrl(url);
    if (!parsedUrl || !steamStoreHosts.has(parsedUrl.hostname.toLowerCase())) return null;

    const pathParts = parsedUrl.pathname.split("/").filter(Boolean);
    const appIndex = pathParts.indexOf("app");
    if (appIndex === -1) return null;

    const appId = Number.parseInt(pathParts[appIndex + 1] ?? "", 10);
    return Number.isNaN(appId) ? null : appId;
};

const extractSteamStoreUrls = (content: string) => {
    if (!content) return [] as string[];
    const regex = new RegExp(steamContentUrlPattern, "gi");
    return [...content.matchAll(regex)].map(([rawUrl]) => rawUrl.replace(trailingPunctuationRegex, ""));
};

const collectSteamReferences = (message: Message): SteamReference[] => {
    const references = new Map<number, string>();

    for (const url of extractSteamStoreUrls(message.content ?? "")) {
        const appId = getSteamStoreAppId(url);
        if (appId == null || references.has(appId)) continue;
        references.set(appId, canonicalSteamUrl(appId));
    }

    for (const { url } of message.embeds ?? []) {
        if (!url) continue;
        const appId = getSteamStoreAppId(url);
        if (appId == null || references.has(appId)) continue;
        references.set(appId, canonicalSteamUrl(appId));
    }

    return [...references.entries()].map(([appId, url]) => ({ appId, url }));
};

const fetchSteamCardPayload = (appId: number) => {
    if (IS_WEB) {
        throw new Error("Steam metadata is unavailable on web.");
    }

    return Native.getSteamCardPayload(appId);
};

const fetchSteamCard = async (appId: number) => {
    const cached = steamCardCache.get(appId);
    if (cached) return cached;

    const pending = steamCardRequests.get(appId);
    if (pending) return pending;

    const request = (async () => {
        const { details, reviewSummary } = await fetchSteamCardPayload(appId);

        const card: SteamCardData = {
            appId,
            description: details.short_description?.trim() ?? "",
            developers: formatList(details.developers, "不明"),
            genres: formatGenres(details.genres),
            imageUrl: details.header_image ?? "",
            name: details.name,
            price: formatPrice(details),
            rating: formatRating(reviewSummary),
            releaseDate: formatReleaseDate(details.release_date),
            url: canonicalSteamUrl(appId)
        };

        steamCardCache.set(appId, card);
        return card;
    })().finally(() => {
        steamCardRequests.delete(appId);
    });

    steamCardRequests.set(appId, request);
    return request;
};

interface SteamCardProps {
    appId: number;
    url: string;
}

const SteamCard = ErrorBoundary.wrap(({ appId, url }: SteamCardProps) => {
    const cached = steamCardCache.get(appId);
    const [state, setState] = useState<SteamCardState>(cached
        ? { status: "loaded", data: cached }
        : { status: "loading" });

    useEffect(() => {
        const cachedData = steamCardCache.get(appId);
        if (cachedData) {
            setState({ status: "loaded", data: cachedData });
            return () => void 0;
        }

        let didCleanup = false;
        setState({ status: "loading" });

        void fetchSteamCard(appId)
            .then(data => {
                if (didCleanup) return;
                setState({ status: "loaded", data });
            })
            .catch(error => {
                logger.error(`Failed to load Steam card for ${appId}`, error);
                if (didCleanup) return;
                setState({ status: "error" });
            });

        return () => {
            didCleanup = true;
        };
    }, [appId]);

    if (state.status === "loading") {
        return <Card className={cl("card")}>
            <BaseText size="sm" className={cl("status")}>Steam 情報を読み込み中です...</BaseText>
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
            {data.imageUrl
                ? <img src={data.imageUrl} alt="" className={cl("image")} />
                : <div className={classes(cl("image"), cl("image-fallback"))}>STEAM</div>
            }
            <div className={cl("top-content")}>
                <a href={url} target="_blank" rel="noreferrer" className={cl("title")}>{data.name}</a>
                <BaseText size="sm" weight="semibold" className={cl("price")}>{data.price}</BaseText>
            </div>
        </div>

        <div className={cl("meta-grid")}>
            <div className={cl("meta-item")}>
                <BaseText size="xs" className={cl("meta-label")}>リリース日</BaseText>
                <BaseText size="sm" className={cl("meta-value")}>{data.releaseDate}</BaseText>
            </div>
            <div className={cl("meta-item")}>
                <BaseText size="xs" className={cl("meta-label")}>評価</BaseText>
                <BaseText size="sm" className={cl("meta-value")}>{data.rating}</BaseText>
            </div>
            <div className={cl("meta-item")}>
                <BaseText size="xs" className={cl("meta-label")}>開発元</BaseText>
                <BaseText size="sm" className={cl("meta-value")}>{data.developers}</BaseText>
            </div>
            <div className={cl("meta-item")}>
                <BaseText size="xs" className={cl("meta-label")}>ジャンル</BaseText>
                <BaseText size="sm" className={cl("meta-value")}>{data.genres}</BaseText>
            </div>
        </div>

        {data.description
            ? <BaseText size="sm" className={cl("description")}>{data.description}</BaseText>
            : null
        }
    </Card>;
}, { noop: true });

export default definePlugin({
    name: "SteamStoreEmbeds",
    description: "Replaces Steam store embeds with Japanese metadata cards.",
    authors: [EquicordDevs.niko],
    patches: [
        {
            find: "renderEmbeds(",
            predicate: () => !IS_WEB,
            replacement: {
                match: /(?<=renderEmbeds\(\i\){.+?embeds\.map\(\((\i),\i\)?=>{)/,
                replace: "$&if($self.isSteamStoreEmbed($1))return null;"
            }
        }
    ],
    isSteamStoreEmbed(embed: { url?: string; }) {
        return typeof embed?.url === "string" && getSteamStoreAppId(embed.url) != null;
    },
    renderMessageAccessory(props) {
        if (IS_WEB) return null;

        const { message } = props as { message?: Message; };
        if (!message) return null;

        const references = collectSteamReferences(message);
        if (!references.length) return null;

        return <div className={cl("list")}>
            {references.map(({ appId, url }) => (
                <SteamCard
                    key={appId}
                    appId={appId}
                    url={url}
                />
            ))}
        </div>;
    }
});
