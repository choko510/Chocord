/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

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

type SteamAppDetailsResponse = Record<string, {
    data?: SteamAppDetails;
    success: boolean;
}>;

interface SteamReviewSummary {
    review_score_desc: string;
    total_positive: number;
    total_reviews: number;
}

interface SteamReviewResponse {
    query_summary?: SteamReviewSummary;
    success: number;
}

export interface SteamCardPayload {
    details: SteamAppDetails;
    reviewSummary: SteamReviewSummary | null;
}

async function fetchSteamAppDetails(appId: number) {
    const requestUrl = new URL("https://store.steampowered.com/api/appdetails");
    requestUrl.searchParams.set("appids", `${appId}`);
    requestUrl.searchParams.set("cc", "jp");
    requestUrl.searchParams.set("l", "japanese");

    const response = await fetch(requestUrl.toString());
    if (!response.ok) {
        throw new Error(`Steam API returned ${response.status}.`);
    }

    const body = await response.json() as SteamAppDetailsResponse;
    const payload = body[`${appId}`];

    if (!payload?.success || !payload.data) {
        throw new Error("Steam app details are unavailable.");
    }

    return payload.data;
}

async function fetchSteamReviewSummary(appId: number) {
    const requestUrl = new URL(`https://store.steampowered.com/appreviews/${appId}/`);
    requestUrl.searchParams.set("json", "1");
    requestUrl.searchParams.set("language", "japanese");
    requestUrl.searchParams.set("filter", "summary");
    requestUrl.searchParams.set("purchase_type", "all");
    requestUrl.searchParams.set("num_per_page", "0");

    const response = await fetch(requestUrl.toString());
    if (!response.ok) {
        throw new Error(`Steam review API returned ${response.status}.`);
    }

    const body = await response.json() as SteamReviewResponse;
    if (body.success !== 1 || !body.query_summary) return null;
    return body.query_summary;
}

export async function getSteamCardPayload(_: unknown, appId: number): Promise<SteamCardPayload> {
    if (!Number.isInteger(appId) || appId <= 0) {
        throw new Error("Invalid Steam app ID.");
    }

    const details = await fetchSteamAppDetails(appId);
    const reviewSummary = await fetchSteamReviewSummary(appId).catch(() => null);

    return { details, reviewSummary };
}
