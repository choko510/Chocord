/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { BaseText } from "@components/BaseText";
import { Card } from "@components/Card";
import ErrorBoundary from "@components/ErrorBoundary";
import { classNameFactory } from "@utils/css";
import { Logger } from "@utils/Logger";
import { parseUrl } from "@utils/misc";
import definePlugin from "@utils/types";
import { Message } from "@vencord/discord-types";
import { useEffect, useMemo, useState } from "@webpack/common";

const cl = classNameFactory("vc-risk-url-warning-");
const logger = new Logger("RiskUrlWarning");
const urlPattern = /https?:\/\/[^\s<]+[^<.,:;"')\]\s]/gi;
const trailingPunctuationRegex = /[),.;!?]+$/;

interface RiskApiResponse {
    details?: unknown[];
    risk?: string;
}

interface HostRiskResult {
    details: string[];
    risk: string;
}

interface DangerousHost {
    details: string[];
    host: string;
}

const hostRiskCache = new Map<string, HostRiskResult>();
const hostRiskRequests = new Map<string, Promise<HostRiskResult>>();

const normalizeHost = (host: string) => host.toLowerCase().replace(/\.+$/, "");

const formatRiskDetail = (detail: unknown) => {
    if (typeof detail === "string") return detail;
    if (typeof detail === "number" || typeof detail === "boolean" || detail == null) return String(detail);

    if (Array.isArray(detail)) {
        return detail.map(item => String(item)).join(", ");
    }

    return Object.entries(detail as Record<string, unknown>)
        .map(([key, value]) => `${key}: ${String(value)}`)
        .join(", ");
};

const extractHostsFromContent = (content: string) => {
    if (!content) return [] as string[];

    const hosts = new Set<string>();
    for (const [rawUrl] of content.matchAll(urlPattern)) {
        const parsedUrl = parseUrl(rawUrl.replace(trailingPunctuationRegex, ""));
        const host = parsedUrl?.hostname ? normalizeHost(parsedUrl.hostname) : "";
        if (!host) continue;
        hosts.add(host);
    }

    return [...hosts];
};

const collectMessageHosts = (message: Message) => {
    const hosts = new Set<string>();

    for (const host of extractHostsFromContent(message.content ?? "")) {
        hosts.add(host);
    }

    for (const { url } of message.embeds ?? []) {
        if (!url) continue;
        const parsedUrl = parseUrl(url);
        const host = parsedUrl?.hostname ? normalizeHost(parsedUrl.hostname) : "";
        if (!host) continue;
        hosts.add(host);
    }

    return [...hosts];
};

const getCachedDangerousHosts = (hosts: string[]) => {
    const cachedResults = hosts.map(host => hostRiskCache.get(host));
    if (cachedResults.some(result => result == null)) return null;

    return hosts.flatMap((host, index) => {
        const result = cachedResults[index]!;
        if (result.risk !== "danger") return [];
        return [{ host, details: result.details }];
    });
};

const fetchHostRisk = async (host: string) => {
    const cached = hostRiskCache.get(host);
    if (cached) return cached;

    const pending = hostRiskRequests.get(host);
    if (pending) return pending;

    const request = (async () => {
        const response = await fetch(`https://api.choko.cc/riskurl?url=${encodeURIComponent(host)}`);
        if (!response.ok) {
            throw new Error(`Risk API returned ${response.status} for host ${host}.`);
        }

        const payload = await response.json() as RiskApiResponse;
        const details = Array.isArray(payload.details)
            ? payload.details.map(formatRiskDetail).filter(Boolean)
            : [];

        const result: HostRiskResult = {
            details,
            risk: typeof payload.risk === "string" ? payload.risk.toLowerCase() : ""
        };

        hostRiskCache.set(host, result);
        return result;
    })().finally(() => {
        hostRiskRequests.delete(host);
    });

    hostRiskRequests.set(host, request);
    return request;
};

const resolveDangerousHosts = async (hosts: string[]) => {
    const checkedHosts = await Promise.all(hosts.map(async host => {
        try {
            const result = await fetchHostRisk(host);
            if (result.risk !== "danger") return null;
            return { host, details: result.details } satisfies DangerousHost;
        } catch (error) {
            logger.error(`Failed to evaluate URL risk for ${host}.`, error);
            return null;
        }
    }));

    return checkedHosts.filter((host): host is DangerousHost => host != null);
};

const RiskUrlAccessory = ErrorBoundary.wrap(({ message }: { message: Message; }) => {
    const hosts = useMemo(() => collectMessageHosts(message), [message.content, message.embeds]);
    const [dangerousHosts, setDangerousHosts] = useState<DangerousHost[]>(() => getCachedDangerousHosts(hosts) ?? []);

    useEffect(() => {
        if (!hosts.length) {
            setDangerousHosts([]);
            return () => void 0;
        }

        const cached = getCachedDangerousHosts(hosts);
        if (cached) {
            setDangerousHosts(cached);
            return () => void 0;
        }

        let didCleanup = false;

        void resolveDangerousHosts(hosts).then(results => {
            if (didCleanup) return;
            setDangerousHosts(results);
        });

        return () => {
            didCleanup = true;
        };
    }, [hosts]);

    if (!dangerousHosts.length) return null;

    return (
        <Card className={cl("card")}>
            <BaseText size="sm" weight="semibold" className={cl("title")}>
                危険なURLを検出しました
            </BaseText>
            <ul className={cl("list")}>
                {dangerousHosts.map(({ host, details }) => (
                    <li key={host} className={cl("item")}>
                        <BaseText size="sm" weight="medium" className={cl("host")}>{host}</BaseText>
                        {details.length
                            ? <BaseText size="xs" className={cl("details")}>{details.join(" / ")}</BaseText>
                            : null}
                    </li>
                ))}
            </ul>
        </Card>
    );
}, { noop: true });

export default definePlugin({
    name: "RiskUrlWarning",
    description: "Warns when messages contain dangerous URLs.",
    authors: [{
        name: "eita2",
        id: 0n
    }],
    renderMessageAccessory(props) {
        const { message } = props as { message?: Message; };
        if (!message) return null;
        return <RiskUrlAccessory message={message} />;
    },
    stop() {
        hostRiskCache.clear();
        hostRiskRequests.clear();
    }
});
