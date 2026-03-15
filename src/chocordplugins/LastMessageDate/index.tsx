/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { BaseText } from "@components/BaseText";
import ErrorBoundary from "@components/ErrorBoundary";
import { EquicordDevs } from "@utils/constants";
import { getCurrentChannel } from "@utils/discord";
import { Logger } from "@utils/Logger";
import definePlugin from "@utils/types";
import { findByCodeLazy, findByPropsLazy, findComponentByCodeLazy, findCssClassesLazy } from "@webpack";
import { RestAPI, useEffect, useState } from "@webpack/common";

const logger = new Logger("LastMessageDate");
const WrapperClasses = findCssClassesLazy("memberSinceWrapper");
const ContainerClasses = findCssClassesLazy("memberSince");
const formatDate = findByCodeLazy('month:"short",day:"numeric"');
const locale = findByPropsLazy("getLocale");
const Section = findComponentByCodeLazy("headingVariant:", '"section"', "headingIcon:");

interface SearchMessage {
    author?: { id?: string; };
    hit?: boolean;
    timestamp?: string;
}

interface SearchResponseBody {
    messages?: SearchMessage[][];
    retry_after?: number;
}

type LastMessageState = "loading" | "loaded" | "error";

const lastMessageCache = new Map<string, Date | null>();
const pendingRequests = new Map<string, Promise<Date | null>>();

const toCacheKey = (userId: string, guildId: string | null, channelId: string) => `${guildId ?? `dm:${channelId}`}:${userId}`;

async function getLastMessageDate(userId: string, guildId: string | null, channelId: string) {
    const cacheKey = toCacheKey(userId, guildId, channelId);
    const cached = lastMessageCache.get(cacheKey);
    if (cached !== undefined) return cached;

    const pending = pendingRequests.get(cacheKey);
    if (pending) return pending;

    const request = (async () => {
        const response = await RestAPI.get({
            query: {
                author_id: userId,
                include_nsfw: true
            },
            url: guildId
                ? `/guilds/${guildId}/messages/search`
                : `/channels/${channelId}/messages/search`
        }) as { body?: SearchResponseBody; };

        const retryAfter = response.body?.retry_after;
        if (typeof retryAfter === "number") {
            throw new Error(`Discord rate-limited the search request (${retryAfter}).`);
        }

        const messages = response.body?.messages?.[0];
        if (!Array.isArray(messages)) {
            lastMessageCache.set(cacheKey, null);
            return null;
        }

        const newest = messages.find(message =>
            message?.hit &&
            message.author?.id === userId &&
            typeof message.timestamp === "string"
        ) ?? messages.find(message =>
            message.author?.id === userId &&
            typeof message.timestamp === "string"
        );

        const parsed = newest?.timestamp ? new Date(newest.timestamp) : null;
        const value = parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;
        lastMessageCache.set(cacheKey, value);
        return value;
    })().finally(() => {
        pendingRequests.delete(cacheKey);
    });

    pendingRequests.set(cacheKey, request);
    return request;
}

export default definePlugin({
    name: "LastMessageDate",
    description: "Displays the last message date of a member in the current guild or DM.",
    authors: [EquicordDevs.DevilBro],
    patches: [
        {
            find: ".SIDEBAR}),nicknameIcons",
            replacement: {
                match: /#{intl::USER_PROFILE_MEMBER_SINCE}\),.{0,100}userId:(\i\.id)}\)}\)/,
                replace: "$&,$self.LastMessageDateComponent({userId:$1,isSidebar:true})"
            }
        },
        {
            find: ",applicationRoleConnection:",
            replacement: {
                match: /#{intl::USER_PROFILE_MEMBER_SINCE}\),.{0,100}userId:(\i\.id),.{0,100}}\)}\),/,
                replace: "$&,$self.LastMessageDateComponent({userId:$1,isSidebar:false}),"
            }
        },
        {
            find: ".MODAL_V2,onClose:",
            replacement: {
                match: /#{intl::USER_PROFILE_MEMBER_SINCE}\),.{0,100}userId:(\i\.id),.{0,100}}\)}\),/,
                replace: "$&,$self.LastMessageDateComponent({userId:$1,isSidebar:false}),"
            }
        }
    ],

    LastMessageDateComponent: ErrorBoundary.wrap(({ isSidebar, userId }: { isSidebar: boolean; userId: string; }) => {
        const channel = getCurrentChannel();
        const guildId = channel?.guild_id ?? null;
        const channelId = channel?.id;

        const [status, setStatus] = useState<LastMessageState>("loading");
        const [lastMessageDate, setLastMessageDate] = useState<Date | null>(null);

        useEffect(() => {
            if (!channelId) {
                setStatus("loaded");
                setLastMessageDate(null);
                return () => void 0;
            }

            const cacheKey = toCacheKey(userId, guildId, channelId);
            const cached = lastMessageCache.get(cacheKey);
            if (cached !== undefined) {
                setStatus("loaded");
                setLastMessageDate(cached);
                return () => void 0;
            }

            let didCleanup = false;
            setStatus("loading");

            void getLastMessageDate(userId, guildId, channelId)
                .then(date => {
                    if (didCleanup) return;
                    setLastMessageDate(date);
                    setStatus("loaded");
                })
                .catch(error => {
                    logger.error("Failed to fetch last message date.", error);
                    if (didCleanup) return;
                    setLastMessageDate(null);
                    setStatus("error");
                });

            return () => {
                didCleanup = true;
            };
        }, [channelId, guildId, userId]);

        const value = status === "loading"
            ? "Loading..."
            : status === "error"
                ? "Failed to load"
                : lastMessageDate
                    ? formatDate(lastMessageDate.getTime(), locale.getLocale())
                    : "No messages found";

        if (isSidebar) {
            return (
                <Section
                    heading="Last Message Date"
                    headingVariant="text-xs/semibold"
                    headingColor="text-strong"
                >
                    <BaseText size="sm">{value}</BaseText>
                </Section>
            );
        }

        return (
            <Section
                heading="Last Message Date"
                headingVariant="text-xs/medium"
                headingColor="text-default"
            >
                <div className={WrapperClasses.memberSinceWrapper}>
                    <div className={ContainerClasses.memberSince}>
                        <BaseText size="sm">{value}</BaseText>
                    </div>
                </div>
            </Section>
        );
    }, { noop: true })
});
